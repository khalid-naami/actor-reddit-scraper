import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    parsePostItem,
    parseCommentsTree,
    parseSubredditData,
    parseUserData
} from './extractors.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    mode = 'AUTO_DETECT',
    targetUrls = [],
    searchQueries = [],
    sort = 'hot',
    timeFilter = 'all',
    maxItems = 50,
    maxComments = 30,
    includeComments = true,
    proxyConfiguration
} = input;

log.info('🚀 Starting Reddit Ultimate Scraper...', {
    mode,
    targetUrlsCount: targetUrls.length,
    searchQueriesCount: searchQueries.length,
    sort,
    timeFilter
});

const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

// Default sample targets if nothing provided
let urlsToProcess = [...targetUrls];
if (urlsToProcess.length === 0 && searchQueries.length === 0) {
    urlsToProcess = [
        'https://www.reddit.com/r/technology/hot/',
        'https://www.reddit.com/r/OpenAI/'
    ];
    log.info('ℹ️ No URLs or queries provided. Defaulting to sample targets:', { urls: urlsToProcess });
}

function buildHeaders() {
    return {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
    };
}

// Fast JSON fetcher
async function fetchRedditJson(url) {
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
    const response = await gotScraping({
        url,
        headers: buildHeaders(),
        proxyUrl,
        responseType: 'json',
        timeout: { request: 25000 },
        retry: { limit: 2 }
    });
    return response.body;
}

// Playwright fallback for anti-bot or 429
async function fetchWithPlaywright(url) {
    let jsonResult = null;
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestsPerCrawl: 1,
        headless: true,
        requestHandlerTimeoutSecs: 35,
        async requestHandler({ page }) {
            const bodyText = await page.innerText('body');
            try {
                jsonResult = JSON.parse(bodyText);
            } catch (_) {
                // If not raw JSON, return HTML
                jsonResult = await page.content();
            }
        }
    });

    await crawler.run([url]);
    return jsonResult;
}

// Auto-detect URL mode
function detectUrlType(url, explicitMode) {
    if (explicitMode && explicitMode !== 'AUTO_DETECT') return explicitMode;
    const lower = url.toLowerCase();
    if (lower.includes('/comments/')) return 'COMMENTS';
    if (lower.includes('/user/') || lower.includes('/u/')) return 'USERS';
    if (lower.includes('/about') || lower.includes('/rules')) return 'SUBREDDITS';
    if (lower.includes('/r/')) return 'POSTS';
    return 'POSTS';
}

const stats = {
    posts: 0,
    comments: 0,
    subreddits: 0,
    users: 0,
    searchResults: 0,
    failed: 0
};

// Process Target URLs
for (const rawUrl of urlsToProcess) {
    const url = rawUrl.trim();
    if (!url) continue;

    const currentMode = detectUrlType(url, mode);
    log.info(`🎯 Processing [${currentMode}]: ${url}`);

    try {
        // 1. DIRECT POST & COMMENTS MODE
        if (currentMode === 'COMMENTS' || url.includes('/comments/')) {
            const cleanUrl = url.replace(/\/+$/, '');
            const jsonUrl = cleanUrl.endsWith('.json') ? cleanUrl : `${cleanUrl}.json?limit=${maxComments}&depth=5`;

            let data;
            try {
                data = await fetchRedditJson(jsonUrl);
            } catch (err) {
                log.warning(`⚠️ HTTP fetch failed for post (${err.message}). Trying browser crawler...`);
                data = await fetchWithPlaywright(jsonUrl);
            }

            if (Array.isArray(data) && data.length >= 2) {
                const postData = data[0]?.data?.children?.[0]?.data;
                const post = parsePostItem(postData);
                if (post) {
                    await Actor.pushData(post);
                    stats.posts++;
                    log.info(`✅ Scraped Post: "${post.title}" [Score: ${post.score}]`);
                }

                const commentChildren = data[1]?.data?.children || [];
                const comments = parseCommentsTree(commentChildren, maxComments);
                for (const c of comments) {
                    c.postId = post?.id;
                    c.postTitle = post?.title;
                    await Actor.pushData(c);
                }
                stats.comments += comments.length;
                log.info(`💬 Scraped ${comments.length} threaded comments for post: "${post?.title || url}"`);
            }
        }

        // 2. SUBREDDIT POSTS LISTING MODE
        else if (currentMode === 'POSTS') {
            // Extract subreddit name from URL
            const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
            const subName = match ? match[1] : 'all';
            let collectedPosts = 0;
            let after = null;

            while (collectedPosts < maxItems) {
                const limit = Math.min(100, maxItems - collectedPosts);
                let jsonUrl = `https://www.reddit.com/r/${subName}/${sort}.json?limit=${limit}&t=${timeFilter}`;
                if (after) jsonUrl += `&after=${after}`;

                let data;
                try {
                    data = await fetchRedditJson(jsonUrl);
                } catch (err) {
                    log.warning(`⚠️ HTTP fetch error (${err.message}). Trying browser crawler...`);
                    data = await fetchWithPlaywright(jsonUrl);
                }

                const children = data?.data?.children || [];
                if (children.length === 0) break;

                for (const child of children) {
                    if (collectedPosts >= maxItems) break;
                    const post = parsePostItem(child.data);
                    if (post) {
                        // Optionally fetch top comments for this post
                        if (includeComments && maxComments > 0 && post.id) {
                            try {
                                const cUrl = `https://www.reddit.com/r/${subName}/comments/${post.id}.json?limit=${maxComments}&depth=3`;
                                const cData = await fetchRedditJson(cUrl);
                                if (Array.isArray(cData) && cData[1]?.data?.children) {
                                    const comments = parseCommentsTree(cData[1].data.children, maxComments);
                                    post.topComments = comments;
                                    stats.comments += comments.length;
                                }
                            } catch (_) {}
                        }

                        await Actor.pushData(post);
                        collectedPosts++;
                        stats.posts++;
                    }
                }

                after = data?.data?.after;
                if (!after) break;
                log.info(`📜 Fetched ${collectedPosts}/${maxItems} posts from r/${subName}...`);
            }
            log.info(`✅ Successfully scraped ${collectedPosts} posts from r/${subName}`);
        }

        // 3. SUBREDDIT METRICS & RULES MODE
        else if (currentMode === 'SUBREDDITS') {
            const match = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
            const subName = match ? match[1] : null;

            if (subName) {
                const aboutUrl = `https://www.reddit.com/r/${subName}/about.json`;
                const rulesUrl = `https://www.reddit.com/r/${subName}/about/rules.json`;

                const [aboutRes, rulesRes] = await Promise.allSettled([
                    fetchRedditJson(aboutUrl),
                    fetchRedditJson(rulesUrl)
                ]);

                const subData = aboutRes.status === 'fulfilled' ? aboutRes.value?.data : null;
                const rulesData = rulesRes.status === 'fulfilled' ? rulesRes.value : null;

                const subreddit = parseSubredditData(subData, rulesData);
                if (subreddit) {
                    await Actor.pushData(subreddit);
                    stats.subreddits++;
                    log.info(`✅ Successfully scraped Subreddit: ${subreddit.name} [Subscribers: ${subreddit.subscribers.toLocaleString()}]`);
                }
            }
        }

        // 4. USER PROFILES MODE
        else if (currentMode === 'USERS') {
            const match = url.match(/\/(?:user|u)\/([a-zA-Z0-9_-]+)/i);
            const username = match ? match[1] : null;

            if (username) {
                const aboutUrl = `https://www.reddit.com/user/${username}/about.json`;
                const data = await fetchRedditJson(aboutUrl);
                const user = parseUserData(data?.data);
                if (user) {
                    await Actor.pushData(user);
                    stats.users++;
                    log.info(`✅ Successfully scraped User: ${user.username} [Karma: ${user.userKarma.toLocaleString()}]`);
                }
            }
        }

    } catch (err) {
        log.error(`❌ Error scraping ${url}: ${err.message}`);
        stats.failed++;
    }
}

// 5. SEARCH QUERIES MODE
if (searchQueries.length > 0) {
    for (const query of searchQueries) {
        log.info(`🔍 Searching Reddit for: "${query}" (sort: ${sort}, time: ${timeFilter})`);
        try {
            let collected = 0;
            let after = null;

            while (collected < maxItems) {
                const limit = Math.min(100, maxItems - collected);
                let searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${timeFilter}&limit=${limit}`;
                if (after) searchUrl += `&after=${after}`;

                const data = await fetchRedditJson(searchUrl);
                const children = data?.data?.children || [];
                if (children.length === 0) break;

                for (const child of children) {
                    if (collected >= maxItems) break;
                    const item = parsePostItem(child.data);
                    if (item) {
                        item.searchQuery = query;
                        await Actor.pushData(item);
                        collected++;
                        stats.searchResults++;
                    }
                }

                after = data?.data?.after;
                if (!after) break;
            }
            log.info(`✅ Found and scraped ${collected} results for query: "${query}"`);
        } catch (err) {
            log.error(`❌ Search failed for "${query}": ${err.message}`);
            stats.failed++;
        }
    }
}

// Save overview summary
const summary = {
    status: 'COMPLETED',
    timestamp: new Date().toISOString(),
    metrics: stats,
    totalRecordsExtracted: stats.posts + stats.comments + stats.subreddits + stats.users + stats.searchResults,
    message: 'Reddit Ultimate Scraper completed successfully.'
};

await Actor.setValue('OUTPUT', summary);
log.info('🏁 Execution Finished. Executive Summary:', summary);

await Actor.exit();
