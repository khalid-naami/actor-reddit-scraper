import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    parsePostItem,
    parseCommentsTree,
    parseSubredditData,
    parseUserData,
    parseRedditRssFeed,
    buildSubredditFromRssFeed,
    parseRedditHtmlDom,
    parseCustomCookies,
    normalizeRedditUrl,
    detectRedditUrlType,
    extractSubredditName,
    extractUsername,
    extractSearchParamsFromUrl,
    normalizeSubredditSort,
    detectRedditBlock,
    sanitizeRecord
} from './extractors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OAUTH_USER_AGENT = 'nodejs:actor-reddit-scraper:v1.0.0 (by /u/apify_reddit_scraper)';

await Actor.init();

const diagnostics = [];
function addDiagnostic(msg) {
    if (msg && !diagnostics.includes(msg)) {
        diagnostics.push(msg);
    }
}

try {
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
        proxyConfiguration,
        redditClientId = process.env.REDDIT_CLIENT_ID || '',
        redditClientSecret = process.env.REDDIT_CLIENT_SECRET || '',
        customCookies = ''
    } = input;

    const cleanClientId = String(redditClientId || '').trim();
    const cleanClientSecret = String(redditClientSecret || '').trim();
    const hasOAuthCreds = Boolean(cleanClientId && cleanClientSecret);
    const { cookiesArray, cookieHeader } = parseCustomCookies(customCookies);
    const hasCookies = cookiesArray.length > 0;
    const isResidentialProxy = Boolean(
        proxyConfiguration?.useApifyProxy &&
        Array.isArray(proxyConfiguration.apifyProxyGroups) &&
        proxyConfiguration.apifyProxyGroups.some((g) => /residential/i.test(String(g)))
    );

    log.info('🚀 Starting Reddit Ultimate Scraper...', {
        mode,
        targetUrlsCount: Array.isArray(targetUrls) ? targetUrls.length : 0,
        searchQueriesCount: Array.isArray(searchQueries) ? searchQueries.length : 0,
        sort,
        timeFilter,
        maxItems,
        hasOAuthCreds,
        hasCookies,
        isResidentialProxy
    });

    let proxyConfig;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        } catch (err) {
            log.warning(`⚠️ Proxy initialization failed (${err.message}). Continuing without Apify proxy.`);
            addDiagnostic(`Proxy initialization skipped: ${err.message}`);
            proxyConfig = undefined;
        }
    }

    // Default sample targets if nothing provided
    let rawTargets = Array.isArray(targetUrls) ? [...targetUrls] : [];
    const normalizedSearchQueries = Array.isArray(searchQueries)
        ? searchQueries.map((q) => String(q || '').trim()).filter(Boolean)
        : [];

    if (rawTargets.length === 0 && normalizedSearchQueries.length === 0) {
        rawTargets = [
            'https://www.reddit.com/r/technology/hot/',
            'https://www.reddit.com/r/OpenAI/'
        ];
        log.info('ℹ️ No URLs or queries provided. Defaulting to sample targets:', { urls: rawTargets });
    }

    const stats = {
        posts: 0,
        comments: 0,
        subreddits: 0,
        users: 0,
        searchResults: 0,
        failed: 0
    };

    // Circuit-breakers to avoid flooding known-blocked endpoints on unauthenticated datacenter IPs
    const state = {
        unauthJsonBlocked: false,
        playwrightChallengeBlocked: false,
        lastRssFetchAt: 0,
        nextRssEarliestAt: 0,
        oauthToken: null,
        oauthExpiresAt: 0,
        oauthInvalid: false,
        pwRunSeq: 0
    };

    async function getProxyUrl() {
        return proxyConfig ? await proxyConfig.newUrl() : undefined;
    }

    // Tier 1: Official Reddit OAuth client_credentials -> oauth.reddit.com
    async function getOAuthToken() {
        if (!hasOAuthCreds || state.oauthInvalid) return null;
        if (state.oauthToken && Date.now() < state.oauthExpiresAt - 60_000) {
            return state.oauthToken;
        }

        const basic = Buffer.from(`${cleanClientId}:${cleanClientSecret}`).toString('base64');
        const proxyUrl = await getProxyUrl();

        const res = await gotScraping({
            url: 'https://www.reddit.com/api/v1/access_token',
            method: 'POST',
            useHeaderGenerator: false,
            headers: {
                'Authorization': `Basic ${basic}`,
                'User-Agent': OAUTH_USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: 'grant_type=client_credentials',
            proxyUrl,
            responseType: 'text',
            throwHttpErrors: false,
            timeout: { request: 20000 }
        });

        if (res.statusCode !== 200) {
            state.oauthInvalid = true;
            const msg = `Reddit OAuth authentication failed (HTTP ${res.statusCode}). Check redditClientId/redditClientSecret.`;
            log.warning(`⚠️ ${msg}`);
            addDiagnostic(msg);
            return null;
        }

        const tokenData = JSON.parse(res.body);
        if (!tokenData?.access_token) {
            state.oauthInvalid = true;
            addDiagnostic('Reddit OAuth token endpoint returned no access_token.');
            return null;
        }

        state.oauthToken = tokenData.access_token;
        state.oauthExpiresAt = Date.now() + (Number(tokenData.expires_in) || 3600) * 1000;
        log.info('🔑 Authenticated with Official Reddit OAuth API (oauth.reddit.com).');
        return state.oauthToken;
    }

    async function fetchViaOAuth(pathAndQuery) {
        const token = await getOAuthToken();
        if (!token) return { ok: false, reason: 'OAuth unavailable' };

        const parsed = new URL(pathAndQuery.startsWith('http') ? pathAndQuery : `https://www.reddit.com${pathAndQuery}`);
        parsed.hostname = 'oauth.reddit.com';
        parsed.pathname = parsed.pathname.replace(/\.json$/i, '');
        if (!parsed.searchParams.has('raw_json')) {
            parsed.searchParams.set('raw_json', '1');
        }

        const proxyUrl = await getProxyUrl();
        const res = await gotScraping({
            url: parsed.toString(),
            useHeaderGenerator: false,
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': OAUTH_USER_AGENT,
                'Accept': 'application/json'
            },
            proxyUrl,
            responseType: 'text',
            throwHttpErrors: false,
            timeout: { request: 25000 }
        });

        const block = detectRedditBlock({
            statusCode: res.statusCode,
            body: res.body,
            finalUrl: res.url,
            contentType: res.headers['content-type'],
            expectJson: true
        });
        if (block.blocked) {
            return { ok: false, block, reason: block.reason };
        }

        return { ok: true, data: JSON.parse(res.body), source: 'oauth' };
    }

    // Tier 2: Fast gotScraping JSON fetcher with strict HTTP + HTML-block detection
    async function fetchViaGotJson(jsonUrl) {
        if (state.unauthJsonBlocked && !hasCookies && !isResidentialProxy && !proxyConfig) {
            return {
                ok: false,
                block: { blocked: true, statusCode: 403, challenge: false, reason: 'Unauthenticated Reddit .json previously returned HTTP 403' },
                reason: 'Unauthenticated Reddit .json previously returned HTTP 403'
            };
        }

        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9'
        };
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }

        const maxAttempts = proxyConfig ? (isResidentialProxy ? 3 : 3) : 1;
        let lastFailure = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const proxyUrl = await getProxyUrl();
            const res = await gotScraping({
                url: jsonUrl,
                headerGeneratorOptions: {
                    browsers: [{ name: 'chrome', minVersion: 124 }],
                    operatingSystems: ['windows', 'macos']
                },
                headers,
                proxyUrl,
                responseType: 'text',
                throwHttpErrors: false,
                timeout: { request: 25000 },
                retry: { limit: 0 }
            });

            const block = detectRedditBlock({
                statusCode: res.statusCode,
                body: res.body,
                finalUrl: res.url,
                contentType: res.headers['content-type'],
                expectJson: true
            });

            if (!block.blocked) {
                try {
                    return { ok: true, data: JSON.parse(res.body), source: 'json' };
                } catch (parseErr) {
                    lastFailure = {
                        ok: false,
                        block: { blocked: true, statusCode: res.statusCode, reason: `Invalid JSON from Reddit: ${parseErr.message}` },
                        reason: `Invalid JSON from Reddit: ${parseErr.message}`
                    };
                }
            } else {
                lastFailure = { ok: false, block, reason: block.reason };
                if (block.statusCode === 403 && !hasCookies && !proxyConfig) {
                    state.unauthJsonBlocked = true;
                    break;
                }
            }
        }

        return lastFailure || { ok: false, reason: 'Reddit JSON request failed' };
    }

    // Tier 3: Polite Atom .rss fetcher honoring x-ratelimit-reset / retry-after headers & proxy rotation
    async function fetchRedditRss(rssUrl) {
        const maxAttempts = proxyConfig ? 3 : 2;
        let lastReason = 'Reddit RSS request failed';
        let lastBlock = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const now = Date.now();
            const minGapMs = proxyConfig ? 500 : 2000;
            const waitUntil = Math.max(state.nextRssEarliestAt, state.lastRssFetchAt + minGapMs);
            if (waitUntil > now) {
                await sleep(waitUntil - now);
            }
            state.lastRssFetchAt = Date.now();

            const headers = {
                'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            };
            if (cookieHeader) {
                headers.Cookie = cookieHeader;
            }
            if (attempt === 0) {
                headers['User-Agent'] = OAUTH_USER_AGENT;
            }

            const proxyUrl = await getProxyUrl();
            const res = await gotScraping({
                url: rssUrl,
                useHeaderGenerator: attempt > 0,
                ...(attempt > 0 ? {
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 124 }],
                        operatingSystems: ['windows', 'macos']
                    }
                } : {}),
                headers,
                proxyUrl,
                responseType: 'text',
                throwHttpErrors: false,
                timeout: { request: 25000 },
                retry: { limit: 0 }
            });

            const remaining = Number(res.headers['x-ratelimit-remaining']);
            const resetSecs = Number(res.headers['x-ratelimit-reset']);
            if (Number.isFinite(remaining) && remaining <= 1 && !proxyConfig) {
                const resetWaitMs = Number.isFinite(resetSecs) && resetSecs > 0
                    ? Math.min(12000, (resetSecs + 1) * 1000)
                    : 4000;
                state.nextRssEarliestAt = Date.now() + resetWaitMs;
            }

            if (res.statusCode === 429 && attempt + 1 < maxAttempts) {
                const retryAfterSecs = Number(res.headers['retry-after']);
                const backoffMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
                    ? Math.min(15000, retryAfterSecs * 1000)
                    : (Number.isFinite(resetSecs) && resetSecs > 0 ? Math.min(12000, (resetSecs + 2) * 1000) : 4500);
                log.warning(`⏳ Reddit RSS rate-limited (HTTP 429). Waiting ${Math.round(backoffMs / 1000)}s before retrying...`);
                await sleep(backoffMs);
                continue;
            }

            const block = detectRedditBlock({
                statusCode: res.statusCode,
                body: res.body,
                finalUrl: res.url,
                contentType: res.headers['content-type'],
                expectJson: false
            });

            if (block.blocked) {
                lastBlock = block;
                lastReason = block.reason;
                if (proxyConfig && attempt + 1 < maxAttempts) {
                    continue;
                }
                return { ok: false, block, reason: block.reason };
            }

            if (typeof res.body === 'string' && res.body.includes('<feed')) {
                return { ok: true, xml: res.body, source: 'rss' };
            }

            lastReason = 'Expected Atom <feed> XML from Reddit .rss endpoint';
        }

        return { ok: false, block: lastBlock, reason: lastReason };
    }

    // Tier 4: Crawlee 3.16 compatible Playwright fallback (strictly detects challenges/blocks without bypassing)
    async function fetchWithPlaywright(targetUrl, options = {}) {
        if (state.playwrightChallengeBlocked && !hasCookies && !proxyConfig) {
            return {
                ok: false,
                reason: 'Reddit previously presented anti-bot JS/network block to Playwright without cookies or proxies'
            };
        }

        const expectJson = Boolean(options.expectJson);
        const maxDomItems = options.maxItems ?? 50;
        const maxDomComments = options.maxComments ?? 30;
        let outcome = { ok: false, reason: 'Playwright did not produce a response' };

        const queueName = `reddit-pw-${Date.now()}-${++state.pwRunSeq}`;
        const requestQueue = await Actor.openRequestQueue(queueName);

        try {
            await requestQueue.addRequest({ url: targetUrl });

            const crawler = new PlaywrightCrawler({
                requestQueue,
                proxyConfiguration: proxyConfig,
                maxRequestRetries: proxyConfig ? 2 : 0,
                headless: true,
                navigationTimeoutSecs: 35,
                requestHandlerTimeoutSecs: 45,
                preNavigationHooks: [
                    async (crawlingContext, hookGotoOptions) => {
                        const { page } = crawlingContext;
                        const gotoOptions = crawlingContext.gotoOptions ?? hookGotoOptions;
                        if (gotoOptions) {
                            gotoOptions.waitUntil = 'domcontentloaded';
                            gotoOptions.timeout = 35000;
                        }
                        if (cookiesArray.length > 0) {
                            await page.context().addCookies(cookiesArray).catch(() => {});
                        }
                        await page.route('**/*.{woff,woff2,mp4,webm,m4v,avi}', (route) => route.abort().catch(() => {}));
                    }
                ],
                async requestHandler({ page, response }) {
                    const statusCode = response?.status() ?? 200;
                    const finalUrl = page.url();
                    const contentType = response?.headers()['content-type'] || '';

                    if (expectJson || contentType.includes('application/json')) {
                        const rawText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
                        const trimmed = rawText.trim();
                        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                            try {
                                const parsed = JSON.parse(trimmed);
                                outcome = { ok: true, kind: 'json', data: parsed, source: 'playwright_json' };
                                return;
                            } catch (_) {
                                // Fall through to HTML block inspection
                            }
                        }
                    }

                    await page.waitForTimeout(1500);
                    const html = await page.content();
                    const block = detectRedditBlock({
                        statusCode,
                        body: html,
                        finalUrl,
                        contentType,
                        expectJson: false
                    });

                    if (block.blocked) {
                        if ((block.challenge || block.statusCode === 403) && !hasCookies && !proxyConfig) {
                            state.playwrightChallengeBlocked = true;
                        }
                        outcome = { ok: false, block, reason: block.reason };
                        return;
                    }

                    // Extract rich DOM data from rendered Shreddit / Search web components if present
                    const domData = await page.evaluate(({ maxP, maxC }) => {
                        const posts = [];
                        document.querySelectorAll('shreddit-post').forEach((el) => {
                            if (posts.length >= maxP) return;
                            const bodyEl = el.querySelector('[slot="text-body"]');
                            posts.push({
                                id: el.getAttribute('id') || '',
                                title: el.getAttribute('post-title') || '',
                                author: el.getAttribute('author') || '',
                                subreddit: el.getAttribute('subreddit-prefixed-name') || el.getAttribute('subreddit-name') || '',
                                permalink: el.getAttribute('permalink') || '',
                                contentHref: el.getAttribute('content-href') || '',
                                score: el.getAttribute('score') || '0',
                                commentCount: el.getAttribute('comment-count') || '0',
                                postType: el.getAttribute('post-type') || 'text',
                                createdAt: el.getAttribute('created-timestamp') || '',
                                body: bodyEl ? bodyEl.innerText.trim() : ''
                            });
                        });

                        if (posts.length === 0) {
                            const seenUrls = new Set();
                            document.querySelectorAll('a[data-testid="post-title"], a[data-testid="post-title-text"], [data-testid="post-title"] a[href*="/comments/"]').forEach((anchor) => {
                                if (posts.length >= maxP) return;
                                const href = anchor.getAttribute('href') || '';
                                const titleText = (anchor.innerText || anchor.getAttribute('aria-label') || '').trim();
                                if (!href || !titleText || seenUrls.has(href)) return;
                                seenUrls.add(href);
                                const idMatch = href.match(/\/comments\/([a-z0-9]+)/i);
                                const subMatch = href.match(/\/r\/([^/?#]+)/i);
                                const container = anchor.closest('[data-testid="search-post-unit"], [data-testid="post-container"], faceplate-tracker, article, div');
                                const authorLink = container?.querySelector('a[href*="/user/"], a[href*="/u/"]');
                                const rawAuthor = authorLink ? (authorLink.innerText || '').replace(/^\/?u\//i, '').trim() : '';
                                posts.push({
                                    id: idMatch ? `t3_${idMatch[1]}` : '',
                                    title: titleText,
                                    author: rawAuthor,
                                    subreddit: subMatch ? `r/${subMatch[1]}` : '',
                                    permalink: href.startsWith('/') ? href : '',
                                    contentHref: href,
                                    score: '0',
                                    commentCount: '0',
                                    postType: 'text',
                                    createdAt: '',
                                    body: ''
                                });
                            });
                        }

                        const comments = [];
                        document.querySelectorAll('shreddit-comment').forEach((el) => {
                            if (comments.length >= maxC) return;
                            const bodyEl = el.querySelector('[slot="comment"]');
                            comments.push({
                                thingId: el.getAttribute('thingid') || '',
                                parentId: el.getAttribute('parentid') || '',
                                author: el.getAttribute('author') || '',
                                permalink: el.getAttribute('permalink') || '',
                                score: el.getAttribute('score') || '0',
                                depth: el.getAttribute('depth') || '0',
                                body: bodyEl ? bodyEl.innerText.trim() : ''
                            });
                        });

                        return { posts, comments, pageTitle: document.title || '' };
                    }, { maxP: maxDomItems, maxC: maxDomComments }).catch(() => null);

                    if (domData && (domData.posts.length > 0 || domData.comments.length > 0)) {
                        const formattedPosts = domData.posts.map((p) => sanitizeRecord({
                            type: 'POST',
                            id: p.id.startsWith('t3_') ? p.id.slice(3) : (p.id || undefined),
                            name: p.id || undefined,
                            url: p.permalink ? `https://www.reddit.com${p.permalink}` : (p.contentHref || undefined),
                            title: p.title,
                            body: p.body,
                            author: p.author ? `u/${p.author}` : '[deleted]',
                            authorRaw: p.author || '[deleted]',
                            subreddit: p.subreddit ? (p.subreddit.startsWith('r/') ? p.subreddit : `r/${p.subreddit}`) : undefined,
                            score: Number(p.score) || 0,
                            numComments: Number(p.commentCount) || 0,
                            postType: ['image', 'video', 'gallery', 'link', 'text'].includes(p.postType) ? p.postType : 'text',
                            externalUrl: p.postType === 'link' && p.contentHref ? p.contentHref : undefined,
                            mediaUrl: ['image', 'video'].includes(p.postType) && p.contentHref ? p.contentHref : undefined,
                            source: 'reddit_dom',
                            createdAt: p.createdAt || undefined,
                            scrapedAt: new Date().toISOString()
                        })).filter((x) => x && (x.title || x.id));

                        const formattedComments = domData.comments.map((c) => sanitizeRecord({
                            type: 'COMMENT',
                            id: c.thingId.startsWith('t1_') ? c.thingId.slice(3) : (c.thingId || undefined),
                            parentId: c.parentId || undefined,
                            url: c.permalink ? `https://www.reddit.com${c.permalink}` : undefined,
                            author: c.author ? `u/${c.author}` : '[deleted]',
                            authorRaw: c.author || '[deleted]',
                            body: c.body,
                            score: Number(c.score) || 0,
                            depth: Number(c.depth) || 0,
                            source: 'reddit_dom',
                            scrapedAt: new Date().toISOString()
                        })).filter((x) => x && (x.body || x.id));

                        outcome = {
                            ok: true,
                            kind: 'dom',
                            posts: formattedPosts,
                            comments: formattedComments,
                            source: 'playwright_dom'
                        };
                        return;
                    }

                    // Fallback HTML string parser
                    const parsedHtml = parseRedditHtmlDom(html, { maxItems: maxDomItems, maxComments: maxDomComments });
                    if (parsedHtml.posts.length > 0 || parsedHtml.comments.length > 0) {
                        outcome = {
                            ok: true,
                            kind: 'dom',
                            posts: parsedHtml.posts,
                            comments: parsedHtml.comments,
                            source: 'playwright_dom'
                        };
                        return;
                    }

                    outcome = {
                        ok: false,
                        reason: `Playwright HTTP ${statusCode} (title="${domData?.pageTitle || ''}") without extractable Reddit JSON or post elements`
                    };
                },
                failedRequestHandler({ request }, err) {
                    outcome = { ok: false, reason: `Playwright failed on ${request.url}: ${err.message}` };
                }
            });

            await crawler.run();
        } finally {
            await requestQueue.drop().catch(() => {});
        }

        return outcome;
    }

    // Unified JSON fetcher across OAuth -> gotScraping -> optional Playwright JSON
    async function fetchRedditJson(jsonUrl, { allowPlaywright = true } = {}) {
        if (hasOAuthCreds && !state.oauthInvalid) {
            const oauthRes = await fetchViaOAuth(jsonUrl);
            if (oauthRes.ok) return oauthRes;
            log.warning(`⚠️ OAuth API issue for ${jsonUrl}: ${oauthRes.reason}`);
        }

        const gotRes = await fetchViaGotJson(jsonUrl);
        if (gotRes.ok) return gotRes;

        const shouldTryPw = allowPlaywright && (hasCookies || isResidentialProxy || gotRes.block?.statusCode !== 403);
        if (shouldTryPw) {
            log.warning(`⚠️ HTTP JSON fetch failed (${gotRes.reason}). Trying Playwright browser fallback...`);
            const pwRes = await fetchWithPlaywright(jsonUrl, { expectJson: true });
            if (pwRes.ok && pwRes.kind === 'json') {
                return { ok: true, data: pwRes.data, source: pwRes.source };
            }
            return { ok: false, reason: pwRes.reason || gotRes.reason, block: pwRes.block || gotRes.block };
        }

        return gotRes;
    }

    // Helper: Scrape comments from a direct post URL (/comments/...)
    async function scrapePostComments(postUrl) {
        const cleanBase = postUrl.split('?')[0].split('#')[0].replace(/\/+(?:\.json|\.rss)?$/, '');
        const jsonUrl = `${cleanBase}.json?limit=${maxComments}&depth=5&raw_json=1`;

        const jsonRes = await fetchRedditJson(jsonUrl, { allowPlaywright: false });
        if (jsonRes.ok && Array.isArray(jsonRes.data) && jsonRes.data.length >= 2) {
            const postData = jsonRes.data[0]?.data?.children?.[0]?.data;
            const post = parsePostItem(postData);
            if (post) {
                await Actor.pushData(post);
                stats.posts++;
            }
            const commentChildren = jsonRes.data[1]?.data?.children || [];
            const comments = parseCommentsTree(commentChildren, maxComments);
            for (const c of comments) {
                const enriched = sanitizeRecord({
                    ...c,
                    postId: post?.id,
                    postTitle: post?.title
                });
                await Actor.pushData(enriched);
            }
            stats.comments += comments.length;
            log.info(`💬 Scraped ${comments.length} threaded comments for post: "${post?.title || postUrl}"`);
            return comments.length + (post ? 1 : 0);
        }

        // Fallback to post Atom .rss feed (contains parent post entry + top comment entries)
        log.warning(`⚠️ Post JSON unavailable (${jsonRes.reason}). Trying Atom .rss fallback...`);
        const rssUrl = `${cleanBase}/.rss?limit=${Math.min(100, Math.max(10, maxComments + 1))}`;
        const rssRes = await fetchRedditRss(rssUrl);
        if (rssRes.ok) {
            const parsed = parseRedditRssFeed(rssRes.xml, { maxItems: 1, maxComments });
            const parentPost = parsed.posts[0];
            let pushed = 0;
            if (parentPost) {
                await Actor.pushData(parentPost);
                stats.posts++;
                pushed++;
            }
            for (const c of parsed.comments) {
                await Actor.pushData(sanitizeRecord({
                    ...c,
                    postId: c.postId || parentPost?.id,
                    postTitle: c.postTitle || parentPost?.title
                }));
                stats.comments++;
                pushed++;
            }
            if (pushed > 0) {
                log.info(`💬 Scraped ${parsed.comments.length} comments (+${parentPost ? 1 : 0} post) via RSS for ${cleanBase}`);
                return pushed;
            }
        }

        // Last resort: Playwright HTML DOM on post page
        const pwRes = await fetchWithPlaywright(cleanBase, { expectJson: false, maxItems: 1, maxComments });
        if (pwRes.ok && pwRes.kind === 'dom') {
            let pushed = 0;
            if (pwRes.posts[0]) {
                await Actor.pushData(pwRes.posts[0]);
                stats.posts++;
                pushed++;
            }
            for (const c of pwRes.comments) {
                await Actor.pushData(c);
                stats.comments++;
                pushed++;
            }
            if (pushed > 0) return pushed;
        }

        const reason = rssRes.reason || jsonRes.reason || pwRes.reason || 'Unknown error';
        throw new Error(`Could not extract post/comments from ${postUrl}: ${reason}`);
    }

    const searchTasks = normalizedSearchQueries.map((query) => ({
        query,
        subreddit: null,
        searchSort: sort,
        searchTime: timeFilter
    }));

    // Process Target URLs
    for (const rawItem of rawTargets) {
        const url = normalizeRedditUrl(rawItem);
        if (!url) {
            log.warning('⚠️ Skipping invalid Reddit URL:', { rawItem });
            addDiagnostic(`Invalid Reddit target URL skipped: ${JSON.stringify(rawItem)}`);
            stats.failed++;
            continue;
        }

        const currentMode = detectRedditUrlType(url, mode);
        log.info(`🎯 Processing [${currentMode}]: ${url}`);

        try {
            // 1. DIRECT POST & COMMENTS MODE
            if (currentMode === 'COMMENTS' || url.includes('/comments/')) {
                if (url.includes('/comments/')) {
                    await scrapePostComments(url);
                } else {
                    // User selected COMMENTS mode on a subreddit URL: discover recent posts first
                    const subName = extractSubredditName(url) || 'all';
                    const subSort = normalizeSubredditSort(sort);
                    const listUrl = `https://www.reddit.com/r/${subName}/${subSort}.json?limit=${Math.min(10, maxItems)}&t=${timeFilter}&raw_json=1`;
                    const listJson = await fetchRedditJson(listUrl);
                    let postLinks = [];
                    let viaRss = false;

                    if (listJson.ok && Array.isArray(listJson.data?.data?.children)) {
                        postLinks = listJson.data.data.children
                            .map((ch) => ch?.data?.permalink ? `https://www.reddit.com${ch.data.permalink}` : null)
                            .filter(Boolean);
                    } else {
                        viaRss = true;
                        const rssList = await fetchRedditRss(`https://www.reddit.com/r/${subName}/${subSort}/.rss?limit=5`);
                        if (rssList.ok) {
                            const parsed = parseRedditRssFeed(rssList.xml, { maxItems: 5 });
                            postLinks = parsed.posts.map((p) => p.url).filter(Boolean);
                        }
                    }

                    const cap = viaRss ? Math.min(3, postLinks.length, maxItems) : Math.min(5, postLinks.length, maxItems);
                    if (cap === 0) {
                        throw new Error(`No posts found in r/${subName} to extract comments from (${listJson.reason || 'empty listing'})`);
                    }
                    for (let i = 0; i < cap; i++) {
                        await scrapePostComments(postLinks[i]);
                    }
                }
            }

            // 2. SUBREDDIT POSTS LISTING MODE
            else if (currentMode === 'POSTS') {
                const subName = extractSubredditName(url) || 'all';
                const subSort = normalizeSubredditSort(sort);
                if (sort === 'relevance') {
                    log.info(`ℹ️ Sort "relevance" is search-only; normalized to "${subSort}" for r/${subName}.`);
                }

                let collectedPosts = 0;
                let after = null;
                let jsonFailureReason = null;

                while (collectedPosts < maxItems) {
                    const limit = Math.min(100, maxItems - collectedPosts);
                    let jsonUrl = `https://www.reddit.com/r/${subName}/${subSort}.json?limit=${limit}&t=${timeFilter}&raw_json=1`;
                    if (after) jsonUrl += `&after=${after}`;

                    const jsonRes = await fetchRedditJson(jsonUrl, { allowPlaywright: false });
                    if (!jsonRes.ok) {
                        jsonFailureReason = jsonRes.reason;
                        break;
                    }

                    const children = jsonRes.data?.data?.children || [];
                    if (children.length === 0) break;

                    for (const child of children) {
                        if (collectedPosts >= maxItems) break;
                        const post = parsePostItem(child?.data);
                        if (!post) continue;

                        post.source = jsonRes.source === 'oauth' ? 'reddit_oauth' : 'reddit_json';

                        if (includeComments && maxComments > 0 && post.id) {
                            const cUrl = `https://www.reddit.com/r/${subName}/comments/${post.id}.json?limit=${maxComments}&depth=3&raw_json=1`;
                            const cRes = await fetchRedditJson(cUrl, { allowPlaywright: false });
                            if (cRes.ok && Array.isArray(cRes.data) && cRes.data[1]?.data?.children) {
                                const comments = parseCommentsTree(cRes.data[1].data.children, maxComments);
                                post.topComments = comments;
                                stats.comments += comments.length;
                            }
                        }

                        await Actor.pushData(post);
                        collectedPosts++;
                        stats.posts++;
                    }

                    after = jsonRes.data?.data?.after;
                    if (!after) break;
                    log.info(`📜 Fetched ${collectedPosts}/${maxItems} posts from r/${subName}...`);
                }

                // Fallback 1: Atom .rss feed (reliably bypasses unauthenticated .json 403 block)
                if (collectedPosts === 0 && jsonFailureReason) {
                    log.warning(`⚠️ JSON posts blocked/unavailable for r/${subName} (${jsonFailureReason}). Trying Atom .rss fallback...`);
                    const rssLimit = Math.min(100, Math.max(25, maxItems));
                    const rssUrl = `https://www.reddit.com/r/${subName}/${subSort}/.rss?limit=${rssLimit}&t=${timeFilter}`;
                    const rssRes = await fetchRedditRss(rssUrl);

                    if (rssRes.ok) {
                        const parsed = parseRedditRssFeed(rssRes.xml, { maxItems, subreddit: subName });
                        if (includeComments && parsed.posts.length > 0) {
                            log.info('ℹ️ Using Atom .rss fallback for posts; skipping inline per-post comment requests to prevent Reddit RSS 429 limits (use Reddit OAuth or Residential proxy for full inline comment trees).');
                        }
                        for (const post of parsed.posts) {
                            if (collectedPosts >= maxItems) break;
                            await Actor.pushData(post);
                            collectedPosts++;
                            stats.posts++;
                        }
                    } else {
                        // Fallback 2: Playwright DOM on web listing
                        log.warning(`⚠️ RSS fallback failed for r/${subName} (${rssRes.reason}). Trying Playwright DOM fallback...`);
                        const pwRes = await fetchWithPlaywright(`https://www.reddit.com/r/${subName}/${subSort}/`, {
                            expectJson: false,
                            maxItems
                        });
                        if (pwRes.ok && pwRes.kind === 'dom') {
                            for (const post of pwRes.posts) {
                                if (collectedPosts >= maxItems) break;
                                await Actor.pushData(post);
                                collectedPosts++;
                                stats.posts++;
                            }
                        } else {
                            throw new Error(`r/${subName}: JSON (${jsonFailureReason}), RSS (${rssRes.reason}), Playwright (${pwRes.reason})`);
                        }
                    }
                }

                if (collectedPosts > 0 && jsonFailureReason) {
                    const warnMsg = `Stopped JSON pagination after ${collectedPosts} posts from r/${subName}: ${jsonFailureReason}`;
                    log.warning(`⚠️ ${warnMsg}`);
                    addDiagnostic(warnMsg);
                }

                if (collectedPosts === 0) {
                    throw new Error(`Extracted 0 posts from r/${subName}${jsonFailureReason ? ` (${jsonFailureReason})` : ''}`);
                }
                log.info(`✅ Successfully scraped ${collectedPosts} posts from r/${subName}`);
            }

            // 3. SUBREDDIT METRICS & RULES MODE
            else if (currentMode === 'SUBREDDITS') {
                const subName = extractSubredditName(url);
                if (!subName) throw new Error(`Could not parse subreddit name from ${url}`);

                const aboutUrl = `https://www.reddit.com/r/${subName}/about.json?raw_json=1`;
                const rulesUrl = `https://www.reddit.com/r/${subName}/about/rules.json?raw_json=1`;

                const aboutRes = await fetchRedditJson(aboutUrl);
                if (aboutRes.ok && aboutRes.data?.data) {
                    const rulesRes = await fetchRedditJson(rulesUrl, { allowPlaywright: false });
                    const subreddit = parseSubredditData(
                        aboutRes.data.data,
                        rulesRes.ok ? rulesRes.data : null
                    );
                    if (subreddit) {
                        subreddit.source = aboutRes.source === 'oauth' ? 'reddit_oauth' : 'reddit_json';
                        await Actor.pushData(subreddit);
                        stats.subreddits++;
                        log.info(`✅ Successfully scraped Subreddit: ${subreddit.name} [Subscribers: ${(subreddit.subscribers || 0).toLocaleString()}]`);
                        continue;
                    }
                }

                log.warning(`⚠️ Subreddit JSON unavailable for r/${subName} (${aboutRes.reason}). Trying Atom .rss metadata fallback...`);
                const rssRes = await fetchRedditRss(`https://www.reddit.com/r/${subName}/hot/.rss?limit=2`);
                if (rssRes.ok) {
                    const parsed = parseRedditRssFeed(rssRes.xml, { maxItems: 2, subreddit: subName });
                    const isRealSub = parsed.feedMeta?.title &&
                        parsed.feedMeta.title.toLowerCase() !== 'reddit' &&
                        (Boolean(parsed.feedMeta.subtitle) || parsed.entriesCount > 0);
                    const subreddit = isRealSub ? buildSubredditFromRssFeed(parsed.feedMeta, subName) : null;
                    if (subreddit) {
                        await Actor.pushData(subreddit);
                        stats.subreddits++;
                        log.info(`✅ Scraped Subreddit metadata via RSS fallback: ${subreddit.name} (note: subscriber counts & rules require OAuth or Residential proxy).`);
                        continue;
                    }
                }

                throw new Error(`Could not scrape subreddit r/${subName}: ${rssRes.reason || aboutRes.reason}`);
            }

            // 4. USER PROFILES MODE
            else if (currentMode === 'USERS') {
                const username = extractUsername(url);
                if (!username) throw new Error(`Could not parse username from ${url}`);

                const aboutUrl = `https://www.reddit.com/user/${username}/about.json?raw_json=1`;
                const jsonRes = await fetchRedditJson(aboutUrl);
                if (jsonRes.ok && jsonRes.data?.data) {
                    const user = parseUserData(jsonRes.data.data);
                    if (user) {
                        user.source = jsonRes.source === 'oauth' ? 'reddit_oauth' : 'reddit_json';
                        await Actor.pushData(user);
                        stats.users++;
                        log.info(`✅ Successfully scraped User: ${user.username} [Karma: ${(user.userKarma || 0).toLocaleString()}]`);
                        continue;
                    }
                }

                log.warning(`⚠️ User JSON unavailable for u/${username} (${jsonRes.reason}). Trying Atom .rss activity fallback...`);
                const rssRes = await fetchRedditRss(`https://www.reddit.com/user/${username}/.rss?limit=10`);
                if (rssRes.ok) {
                    const parsed = parseRedditRssFeed(rssRes.xml, { maxItems: 10 });
                    if (parsed.entriesCount > 0) {
                        const fallbackUser = sanitizeRecord({
                            type: 'USER',
                            username: `u/${username}`,
                            url: `https://www.reddit.com/user/${username}/`,
                            bio: parsed.feedMeta?.subtitle || `Public user activity verified via RSS (${parsed.entriesCount} recent entries). Full karma & account metrics require Reddit OAuth or Residential proxy.`,
                            iconUrl: parsed.feedMeta?.iconUrl,
                            source: 'reddit_rss',
                            scrapedAt: new Date().toISOString()
                        });
                        await Actor.pushData(fallbackUser);
                        stats.users++;
                        log.info(`✅ Scraped User summary via RSS fallback: ${fallbackUser.username}`);
                        continue;
                    }
                }

                throw new Error(`Could not scrape user u/${username}: ${rssRes.reason || jsonRes.reason}`);
            }

            // 5. SEARCH URL PASSED INSIDE targetUrls
            else if (currentMode === 'SEARCH') {
                const params = extractSearchParamsFromUrl(url);
                if (!params.query) {
                    throw new Error(`Search URL missing query parameter (?q=...): ${url}`);
                }
                searchTasks.push({
                    query: params.query,
                    subreddit: params.subreddit,
                    searchSort: params.sort || sort,
                    searchTime: params.timeFilter || timeFilter
                });
            }
        } catch (err) {
            log.error(`❌ Error scraping ${url}: ${err.message}`);
            addDiagnostic(`${url} -> ${err.message}`);
            stats.failed++;
        }
    }

    // 5. SEARCH QUERIES MODE
    for (const task of searchTasks) {
        const { query, subreddit, searchSort, searchTime } = task;
        log.info(`🔍 Searching Reddit for: "${query}" (subreddit: ${subreddit || 'all'}, sort: ${searchSort}, time: ${searchTime})`);

        try {
            let collected = 0;
            let after = null;
            let searchFailureReason = null;

            while (collected < maxItems) {
                const limit = Math.min(100, maxItems - collected);
                const basePath = subreddit
                    ? `https://www.reddit.com/r/${subreddit}/search.json`
                    : 'https://www.reddit.com/search.json';
                let searchUrl = `${basePath}?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(searchSort)}&t=${encodeURIComponent(searchTime)}&limit=${limit}&raw_json=1`;
                if (subreddit) searchUrl += '&restrict_sr=1';
                if (after) searchUrl += `&after=${after}`;

                const jsonRes = await fetchRedditJson(searchUrl, { allowPlaywright: false });
                if (!jsonRes.ok) {
                    searchFailureReason = jsonRes.reason;
                    break;
                }

                const children = jsonRes.data?.data?.children || [];
                if (children.length === 0) break;

                for (const child of children) {
                    if (collected >= maxItems) break;
                    const item = parsePostItem(child?.data);
                    if (item) {
                        item.searchQuery = query;
                        item.source = jsonRes.source === 'oauth' ? 'reddit_oauth' : 'reddit_json';
                        await Actor.pushData(item);
                        collected++;
                        stats.searchResults++;
                    }
                }

                after = jsonRes.data?.data?.after;
                if (!after) break;
            }

            // Fallback: Try Playwright web search page once, then /search.rss
            if (collected === 0 && searchFailureReason) {
                const webSearchUrl = subreddit
                    ? `https://www.reddit.com/r/${subreddit}/search/?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(searchSort)}&t=${encodeURIComponent(searchTime)}`
                    : `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(searchSort)}&t=${encodeURIComponent(searchTime)}`;

                log.warning(`⚠️ Search JSON blocked (${searchFailureReason}). Checking Playwright search DOM fallback...`);
                const pwRes = await fetchWithPlaywright(webSearchUrl, { expectJson: false, maxItems });
                if (pwRes.ok && pwRes.kind === 'dom') {
                    for (const post of pwRes.posts) {
                        if (collected >= maxItems) break;
                        const item = sanitizeRecord({ ...post, searchQuery: query });
                        await Actor.pushData(item);
                        collected++;
                        stats.searchResults++;
                    }
                } else {
                    const rssSearchUrl = subreddit
                        ? `https://www.reddit.com/r/${subreddit}/search.rss?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(searchSort)}&t=${encodeURIComponent(searchTime)}&restrict_sr=1&limit=${Math.min(100, maxItems)}`
                        : `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(searchSort)}&t=${encodeURIComponent(searchTime)}&limit=${Math.min(100, maxItems)}`;
                    const rssRes = await fetchRedditRss(rssSearchUrl);
                    if (rssRes.ok) {
                        const parsed = parseRedditRssFeed(rssRes.xml, { maxItems });
                        for (const post of parsed.posts) {
                            if (collected >= maxItems) break;
                            await Actor.pushData(sanitizeRecord({ ...post, searchQuery: query }));
                            collected++;
                            stats.searchResults++;
                        }
                    } else if (collected === 0) {
                        throw new Error(
                            `Search failed for "${query}": JSON (${searchFailureReason}), Playwright (${pwRes.reason}), RSS (${rssRes.reason}). Provide free redditClientId + redditClientSecret, customCookies, or Apify Residential proxies.`
                        );
                    }
                }
            }

            log.info(`✅ Found and scraped ${collected} results for query: "${query}"`);
        } catch (err) {
            log.error(`❌ Search failed for "${query}": ${err.message}`);
            addDiagnostic(err.message);
            stats.failed++;
        }
    }

    const totalRecordsExtracted = stats.posts + stats.comments + stats.subreddits + stats.users + stats.searchResults;
    const status = totalRecordsExtracted === 0
        ? 'FAILED'
        : (stats.failed > 0 ? 'PARTIAL_SUCCESS' : 'COMPLETED');

    const summary = {
        status,
        timestamp: new Date().toISOString(),
        metrics: stats,
        totalRecordsExtracted,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        message: totalRecordsExtracted === 0
            ? 'Reddit Ultimate Scraper extracted 0 records. See diagnostics for block/auth details.'
            : (stats.failed > 0
                ? 'Reddit Ultimate Scraper completed with partial failures (check diagnostics).'
                : 'Reddit Ultimate Scraper completed successfully.')
    };

    await Actor.setValue('OUTPUT', summary);
    log.info('🏁 Execution Finished. Executive Summary:', summary);

    if (totalRecordsExtracted === 0) {
        const reasonSummary = diagnostics[0] || 'All requests failed or returned 0 records (Reddit likely blocked datacenter/unauthenticated requests with HTTP 403).';
        await Actor.fail(`Extracted 0 Reddit records. ${reasonSummary}`);
    } else {
        await Actor.exit();
    }
} catch (fatalErr) {
    log.error(`💥 Fatal Actor error: ${fatalErr.message}`, { stack: fatalErr.stack });
    await Actor.setValue('OUTPUT', {
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        totalRecordsExtracted: 0,
        diagnostics: [fatalErr.message, ...diagnostics],
        message: `Fatal error: ${fatalErr.message}`
    }).catch(() => {});
    await Actor.fail(fatalErr.message);
}
