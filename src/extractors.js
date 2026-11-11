/**
 * Reddit Ultimate Scraper - High-Speed Extractors
 * Robust parsing for Posts, Nested Comments, Subreddits, Users, Media,
 * Atom RSS fallbacks, Shreddit DOM HTML, URL normalization, and block detection.
 */

// Recursively remove null, undefined, and NaN so emitted items match Draft-07 schema types strictly.
export function sanitizeRecord(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isNaN(value) || !Number.isFinite(value) ? undefined : value;
    }
    if (Array.isArray(value)) {
        const cleaned = [];
        for (const item of value) {
            const next = sanitizeRecord(item);
            if (next !== undefined) cleaned.push(next);
        }
        return cleaned;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const next = sanitizeRecord(v);
            if (next !== undefined) out[k] = next;
        }
        return out;
    }
    return value;
}

export function parseSafeInt(value, fallback = undefined) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.trunc(value) : fallback;
    }
    const str = String(value).trim().toUpperCase().replace(/,/g, '');
    const compact = str.match(/^(-?\d+(?:\.\d+)?)\s*([KMB])$/);
    if (compact) {
        const base = parseFloat(compact[1]);
        const mult = compact[2] === 'K' ? 1e3 : compact[2] === 'M' ? 1e6 : 1e9;
        return Math.round(base * mult);
    }
    const num = Number(str);
    return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

export function parseSafeFloat(value, fallback = undefined) {
    if (value === null || value === undefined || value === '') return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

export function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = parseInt(dec, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&amp;/gi, '&');
}

export function stripHtmlTags(html) {
    if (!html || typeof html !== 'string') return '';
    let text = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
        .replace(/<\s*li\b[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '');
    text = decodeHtmlEntities(text);
    return text
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Helper to extract email addresses
export function extractEmails(text) {
    if (!text || typeof text !== 'string') return [];
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const matches = text.match(emailRegex) || [];
    const ignored = ['reddit.com', 'redditmedia.com', 'redditstatic.com', 'example.com'];
    const unique = [...new Set(matches.map(m => m.trim().toLowerCase()))];
    return unique.filter(e => !ignored.some(d => e === d || e.endsWith(`@${d}`) || e.endsWith(`.${d}`)));
}

// Helper to extract social links
export function extractSocialLinks(text) {
    if (!text || typeof text !== 'string') return [];
    const socials = [];
    const patterns = [
        { platform: 'twitter_x', regex: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+/gi },
        { platform: 'instagram', regex: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/gi },
        { platform: 'youtube', regex: /https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|user\/|channel\/|@)[a-zA-Z0-9_.-]+/gi },
        { platform: 'tiktok', regex: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.-]+/gi },
        { platform: 'discord', regex: /https?:\/\/(?:discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9_-]+/gi },
        { platform: 'telegram', regex: /https?:\/\/(?:t\.me|telegram\.me)\/[a-zA-Z0-9_]+/gi },
        { platform: 'github', regex: /https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+/gi },
        { platform: 'linkedin', regex: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[a-zA-Z0-9_.-]+/gi }
    ];

    for (const { platform, regex } of patterns) {
        const matches = text.match(regex);
        if (matches) {
            for (const url of matches) {
                if (!socials.some(s => s.url === url)) {
                    socials.push({ platform, url });
                }
            }
        }
    }
    return socials;
}

// Unescape Reddit encoded URLs (e.g. &amp; -> &) and resolve relative Reddit paths
export function cleanUrl(url) {
    if (!url || typeof url !== 'string') return undefined;
    const trimmed = url.trim().replace(/&amp;/g, '&');
    if (!trimmed) return undefined;
    if (trimmed.startsWith('/')) {
        return `https://www.reddit.com${trimmed}`;
    }
    return trimmed;
}

// Parse user-supplied cookies from JSON array, JSON map, or Cookie header string
export function parseCustomCookies(rawCookies) {
    if (!rawCookies) return { cookiesArray: [], cookieHeader: '' };

    const normalized = [];
    const pushPair = (name, value, extra = {}) => {
        const n = String(name || '').trim();
        const v = String(value ?? '').trim();
        if (!n || !v) return;
        normalized.push({
            name: n,
            value: v,
            domain: extra.domain || '.reddit.com',
            path: extra.path || '/',
            secure: extra.secure !== undefined ? Boolean(extra.secure) : true,
            httpOnly: Boolean(extra.httpOnly)
        });
    };

    if (Array.isArray(rawCookies)) {
        for (const c of rawCookies) {
            if (c && typeof c === 'object') pushPair(c.name, c.value, c);
        }
    } else if (typeof rawCookies === 'object') {
        for (const [k, v] of Object.entries(rawCookies)) {
            pushPair(k, v);
        }
    } else if (typeof rawCookies === 'string') {
        const trimmed = rawCookies.trim();
        if (!trimmed) return { cookiesArray: [], cookieHeader: '' };

        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                return parseCustomCookies(JSON.parse(trimmed));
            } catch (_) {
                // Fall through to key=value parsing
            }
        }

        const parts = trimmed.split(';');
        for (const part of parts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx > 0) {
                pushPair(part.slice(0, eqIdx), part.slice(eqIdx + 1));
            }
        }
    }

    const cookieHeader = normalized.map(c => `${c.name}=${c.value}`).join('; ');
    return { cookiesArray: normalized, cookieHeader };
}

// Normalize targetUrls item (supports { url }, r/sub, u/user, old.reddit.com, redd.it)
export function normalizeRedditUrl(rawInput) {
    let candidate = '';
    if (typeof rawInput === 'string') {
        candidate = rawInput.trim();
    } else if (rawInput && typeof rawInput === 'object' && typeof rawInput.url === 'string') {
        candidate = rawInput.url.trim();
    }
    if (!candidate) return null;

    if (/^\/?r\/[a-zA-Z0-9_+-]+/i.test(candidate)) {
        const cleanPath = candidate.startsWith('/') ? candidate : `/${candidate}`;
        candidate = `https://www.reddit.com${cleanPath}`;
    } else if (/^\/?(?:u|user)\/[a-zA-Z0-9_-]+/i.test(candidate)) {
        let cleanPath = candidate.startsWith('/') ? candidate : `/${candidate}`;
        cleanPath = cleanPath.replace(/^\/u\//i, '/user/');
        candidate = `https://www.reddit.com${cleanPath}`;
    } else if (!/^https?:\/\//i.test(candidate)) {
        if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(candidate)) {
            candidate = `https://${candidate}`;
        } else {
            return null;
        }
    }

    try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase();

        if (host === 'redd.it') {
            const shortId = parsed.pathname.replace(/^\/+|\/+$/g, '');
            if (!shortId) return null;
            return `https://www.reddit.com/comments/${shortId}/`;
        }

        if (host === 'reddit.com' || host.endsWith('.reddit.com')) {
            parsed.protocol = 'https:';
            parsed.hostname = 'www.reddit.com';
            parsed.pathname = parsed.pathname.replace(/^\/u\//i, '/user/');
            return parsed.toString();
        }

        return null;
    } catch (_) {
        return null;
    }
}

export function detectRedditUrlType(url, explicitMode = 'AUTO_DETECT') {
    if (explicitMode && explicitMode !== 'AUTO_DETECT') return explicitMode;
    const lower = String(url || '').toLowerCase();
    if (lower.includes('/comments/')) return 'COMMENTS';
    if (lower.includes('/search') || /[?&]q=/.test(lower)) return 'SEARCH';
    if (lower.includes('/user/') || lower.includes('/u/')) return 'USERS';
    if (lower.includes('/about') || lower.includes('/rules')) return 'SUBREDDITS';
    return 'POSTS';
}

export function extractSubredditName(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/r\/([^/?#]+)/i);
    return match ? match[1] : null;
}

export function extractUsername(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/\/(?:user|u)\/([^/?#]+)/i);
    return match ? match[1] : null;
}

export function extractSearchParamsFromUrl(url) {
    try {
        const parsed = new URL(url);
        const query = parsed.searchParams.get('q') || '';
        const sort = parsed.searchParams.get('sort') || undefined;
        const timeFilter = parsed.searchParams.get('t') || undefined;
        const subreddit = extractSubredditName(parsed.pathname);
        const restrictSr = parsed.searchParams.get('restrict_sr');
        return { query, subreddit: (subreddit && restrictSr !== '0') ? subreddit : null, sort, timeFilter };
    } catch (_) {
        return { query: '', subreddit: null };
    }
}

export function normalizeSubredditSort(sort) {
    const valid = new Set(['hot', 'new', 'top', 'rising', 'controversial']);
    const s = String(sort || 'hot').toLowerCase();
    return valid.has(s) ? s : 'hot';
}

// Detect Reddit network blocks, rate limits, login redirects, and JS/CAPTCHA gates
export function detectRedditBlock({ statusCode = 200, body = '', finalUrl = '', contentType = '', expectJson = false } = {}) {
    const urlLower = String(finalUrl || '').toLowerCase();
    const ctLower = String(contentType || '').toLowerCase();
    const bodyText = typeof body === 'string'
        ? body
        : (body && typeof body === 'object' ? '' : String(body || ''));
    const lowerSnippet = bodyText.slice(0, 8192).toLowerCase();

    if (statusCode === 429) {
        return {
            blocked: true,
            statusCode: 429,
            retryable: true,
            challenge: false,
            reason: 'HTTP 429 Too Many Requests from Reddit (rate limit reached)'
        };
    }

    if (statusCode === 401 || statusCode === 403) {
        const netSec = lowerSnippet.includes('blocked by network security') || lowerSnippet.includes('reddit.com: forbidden');
        return {
            blocked: true,
            statusCode,
            retryable: false,
            challenge: false,
            reason: netSec
                ? `HTTP ${statusCode} Reddit network security block (datacenter IP / unauthenticated endpoint blocked)`
                : `HTTP ${statusCode} forbidden by Reddit`
        };
    }

    if (statusCode >= 400) {
        return {
            blocked: true,
            statusCode,
            retryable: statusCode >= 500,
            challenge: false,
            reason: `HTTP ${statusCode} from Reddit`
        };
    }

    if (urlLower.includes('/login') || urlLower.includes('reason=lor2')) {
        return {
            blocked: true,
            statusCode,
            retryable: false,
            challenge: false,
            reason: 'Redirected to Reddit login wall'
        };
    }

    if (lowerSnippet.includes('blocked by network security') || lowerSnippet.includes('whoa there, pardner')) {
        return {
            blocked: true,
            statusCode,
            retryable: false,
            challenge: false,
            reason: 'Reddit network security block page returned'
        };
    }

    if (
        lowerSnippet.includes('name="js_challenge"') ||
        lowerSnippet.includes("name='js_challenge'") ||
        lowerSnippet.includes('prove your humanity') ||
        lowerSnippet.includes('g-recaptcha') ||
        lowerSnippet.includes('hcaptcha') ||
        lowerSnippet.includes('cf-turnstile')
    ) {
        return {
            blocked: true,
            statusCode,
            retryable: false,
            challenge: true,
            reason: 'Reddit anti-bot JS/CAPTCHA verification page encountered'
        };
    }

    if (expectJson) {
        const looksHtml = ctLower.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(bodyText);
        if (looksHtml || (typeof body === 'string' && !bodyText.trim().startsWith('{') && !bodyText.trim().startsWith('['))) {
            return {
                blocked: true,
                statusCode,
                retryable: false,
                challenge: false,
                reason: 'Expected Reddit JSON response, received HTML or non-JSON payload'
            };
        }
    }

    return { blocked: false, statusCode };
}

function resolveGalleryExtension(mime) {
    if (!mime || typeof mime !== 'string') return 'jpg';
    if (mime.includes('png')) return 'png';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('webp')) return 'webp';
    return 'jpg';
}

// Parse a single Reddit post object from JSON / OAuth API
export function parsePostItem(postData) {
    if (!postData || typeof postData !== 'object') return null;

    const id = postData.id ? String(postData.id) : undefined;
    if (!id && !postData.title && !postData.permalink) return null;

    const name = postData.name || (id ? `t3_${id}` : undefined);
    const title = String(postData.title || '').trim();
    const body = String(postData.selftext || '').trim();
    const author = postData.author ? String(postData.author) : '[deleted]';
    const rawSub = postData.subreddit ? String(postData.subreddit) : undefined;
    const subreddit = rawSub ? (rawSub.startsWith('r/') ? rawSub : `r/${rawSub}`) : undefined;
    const subredditId = postData.subreddit_id || undefined;
    const score = parseSafeInt(postData.score, 0);
    const upvoteRatio = parseSafeFloat(postData.upvote_ratio);
    const numComments = parseSafeInt(postData.num_comments, 0);
    const permalink = postData.permalink
        ? (String(postData.permalink).startsWith('http') ? cleanUrl(postData.permalink) : `https://www.reddit.com${postData.permalink}`)
        : undefined;
    const rawUrl = cleanUrl(postData.url) || permalink;
    const flair = postData.link_flair_text ? String(postData.link_flair_text) : undefined;
    const isNsfw = Boolean(postData.over_18);
    const isSpoiler = Boolean(postData.spoiler);
    const isStickied = Boolean(postData.stickied);
    const isLocked = Boolean(postData.locked);

    // Media & Post Type classification
    let postType = 'text';
    let mediaUrl;
    const galleryUrls = [];
    let videoUrl;
    let externalUrl;

    // 1. Video
    if (postData.is_video && postData.media?.reddit_video?.fallback_url) {
        postType = 'video';
        videoUrl = cleanUrl(postData.media.reddit_video.fallback_url);
        mediaUrl = videoUrl;
    }
    // 2. Image Gallery
    else if (postData.is_gallery && Array.isArray(postData.gallery_data?.items)) {
        postType = 'gallery';
        for (const item of postData.gallery_data.items) {
            const mediaId = item?.media_id;
            if (!mediaId) continue;
            const meta = postData.media_metadata?.[mediaId];
            const directMetaUrl = cleanUrl(meta?.s?.u || meta?.s?.gif);
            if (directMetaUrl) {
                galleryUrls.push(directMetaUrl);
            } else {
                const ext = resolveGalleryExtension(meta?.m);
                galleryUrls.push(`https://i.redd.it/${mediaId}.${ext}`);
            }
        }
        mediaUrl = galleryUrls[0];
    }
    // 3. Single Image
    else if (rawUrl && (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(rawUrl) || rawUrl.includes('i.redd.it'))) {
        postType = 'image';
        mediaUrl = rawUrl;
    }
    // 4. External link
    else if (rawUrl && !rawUrl.includes('reddit.com') && !rawUrl.includes('redd.it')) {
        postType = 'link';
        externalUrl = rawUrl;
        if (postData.preview?.images?.[0]?.source?.url) {
            mediaUrl = cleanUrl(postData.preview.images[0].source.url);
        }
    } else {
        postType = 'text';
    }

    const createdAt = postData.created_utc ? new Date(postData.created_utc * 1000).toISOString() : undefined;
    const combinedText = `${body}\n${externalUrl || ''}`;
    const emails = extractEmails(combinedText);
    const socialLinks = extractSocialLinks(combinedText);

    return sanitizeRecord({
        type: 'POST',
        id,
        name,
        url: permalink || rawUrl,
        title,
        body,
        author: author !== '[deleted]' ? `u/${author}` : author,
        authorRaw: author,
        subreddit,
        subredditId,
        score,
        upvoteRatio,
        numComments,
        postType,
        flair,
        isNsfw,
        isSpoiler,
        isStickied,
        isLocked,
        mediaUrl,
        galleryUrls: galleryUrls.length > 0 ? galleryUrls : undefined,
        videoUrl,
        externalUrl,
        emails: emails.length > 0 ? emails : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
        source: 'reddit_json',
        createdAt,
        scrapedAt: new Date().toISOString()
    });
}

// Parse recursive comments tree
export function parseCommentsTree(commentChildren, maxComments = 50, currentDepth = 0) {
    const comments = [];

    function traverse(children, depth) {
        if (!Array.isArray(children)) return;

        for (const item of children) {
            if (comments.length >= maxComments) break;
            if (!item || item.kind !== 't1' || !item.data) continue;

            const c = item.data;
            const author = c.author ? String(c.author) : '[deleted]';
            const body = String(c.body || '').trim();
            const createdAt = c.created_utc ? new Date(c.created_utc * 1000).toISOString() : undefined;

            comments.push(sanitizeRecord({
                type: 'COMMENT',
                id: c.id ? String(c.id) : undefined,
                parentId: c.parent_id ? String(c.parent_id) : undefined,
                url: c.permalink ? `https://www.reddit.com${c.permalink}` : undefined,
                author: author !== '[deleted]' ? `u/${author}` : author,
                authorRaw: author,
                body,
                score: parseSafeInt(c.score, 0),
                depth: parseSafeInt(depth, 0),
                isOp: Boolean(c.is_submitter),
                isStickied: Boolean(c.stickied),
                distinguished: c.distinguished ? String(c.distinguished) : undefined,
                source: 'reddit_json',
                createdAt,
                scrapedAt: new Date().toISOString()
            }));

            if (c.replies?.data?.children) {
                traverse(c.replies.data.children, depth + 1);
            }
        }
    }

    traverse(commentChildren, currentDepth);
    return comments;
}

// Parse Subreddit community details
export function parseSubredditData(subData, rulesData = null) {
    if (!subData || typeof subData !== 'object') return null;

    const rawName = subData.display_name ? String(subData.display_name) : undefined;
    if (!rawName && !subData.id && !subData.name) return null;

    const name = rawName ? (rawName.startsWith('r/') ? rawName : `r/${rawName}`) : undefined;
    const title = String(subData.title || rawName || '').trim();
    const description = String(subData.public_description || subData.description || '').trim();
    const subscribers = parseSafeInt(subData.subscribers, 0);
    const activeUsers = parseSafeInt(subData.active_user_count ?? subData.accounts_active, 0);
    const isNsfw = Boolean(subData.over18);
    const createdAt = subData.created_utc ? new Date(subData.created_utc * 1000).toISOString() : undefined;
    const iconUrl = cleanUrl(subData.community_icon || subData.icon_img);
    const bannerUrl = cleanUrl(subData.banner_background_image || subData.banner_img);

    const rules = [];
    if (Array.isArray(rulesData?.rules)) {
        for (const r of rulesData.rules) {
            if (!r) continue;
            const rule = sanitizeRecord({
                priority: parseSafeInt(r.priority),
                shortName: r.short_name ? String(r.short_name) : undefined,
                description: r.description ? String(r.description) : undefined
            });
            if (rule && Object.keys(rule).length > 0) rules.push(rule);
        }
    }

    const emails = extractEmails(description);
    const socialLinks = extractSocialLinks(description);

    return sanitizeRecord({
        type: 'SUBREDDIT',
        id: subData.id || subData.name,
        name,
        url: name ? `https://www.reddit.com/${name}/` : undefined,
        title,
        description,
        subscribers,
        activeUsers,
        isNsfw,
        rules: rules.length > 0 ? rules : undefined,
        iconUrl,
        bannerUrl,
        emails: emails.length > 0 ? emails : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
        source: 'reddit_json',
        createdAt,
        scrapedAt: new Date().toISOString()
    });
}

// Parse User profile data
export function parseUserData(userData) {
    if (!userData || typeof userData !== 'object') return null;

    const rawUsername = userData.name ? String(userData.name) : undefined;
    if (!rawUsername && !userData.id) return null;

    const username = rawUsername ? `u/${rawUsername}` : undefined;
    const postKarma = parseSafeInt(userData.link_karma, 0);
    const commentKarma = parseSafeInt(userData.comment_karma, 0);
    const totalKarma = parseSafeInt(userData.total_karma, postKarma + commentKarma);
    const isGold = Boolean(userData.is_gold);
    const isVerified = Boolean(userData.verified);
    const createdAt = userData.created_utc ? new Date(userData.created_utc * 1000).toISOString() : undefined;
    const bio = String(userData.subreddit?.public_description || '').trim();
    const iconUrl = cleanUrl(userData.icon_img || userData.snoovatar_img);
    const bannerUrl = cleanUrl(userData.subreddit?.banner_img);

    const emails = extractEmails(bio);
    const socialLinks = extractSocialLinks(bio);

    return sanitizeRecord({
        type: 'USER',
        id: userData.id ? String(userData.id) : undefined,
        username,
        url: rawUsername ? `https://www.reddit.com/user/${rawUsername}/` : undefined,
        bio,
        userKarma: totalKarma,
        userPostKarma: postKarma,
        userCommentKarma: commentKarma,
        isGold,
        isVerified,
        iconUrl,
        bannerUrl,
        emails: emails.length > 0 ? emails : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
        source: 'reddit_json',
        createdAt,
        scrapedAt: new Date().toISOString()
    });
}

function getXmlTagText(block, tagName) {
    const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = block.match(regex);
    return match ? decodeHtmlEntities(match[1].trim()) : undefined;
}

function getXmlAttr(block, tagName, attrName) {
    const tagRegex = new RegExp(`<${tagName}\\b([^>]*)/?>`, 'i');
    const tagMatch = block.match(tagRegex);
    if (!tagMatch) return undefined;
    const attrRegex = new RegExp(`\\b${attrName}=["']([^"']*)["']`, 'i');
    const attrMatch = tagMatch[1].match(attrRegex);
    return attrMatch ? decodeHtmlEntities(attrMatch[1].trim()) : undefined;
}

// Parse Reddit Atom .rss XML feeds (Posts, Comments, Subreddit Feed Header, User Activity)
export function parseRedditRssFeed(xmlText, options = {}) {
    const result = {
        feedMeta: null,
        posts: [],
        comments: [],
        entriesCount: 0
    };
    if (!xmlText || typeof xmlText !== 'string' || !xmlText.includes('<feed')) {
        return result;
    }

    const headerChunk = xmlText.split('<entry>')[0] || xmlText;
    const feedTitle = getXmlTagText(headerChunk, 'title');
    const feedSubtitle = getXmlTagText(headerChunk, 'subtitle');
    const feedIcon = cleanUrl(getXmlTagText(headerChunk, 'icon'));
    const feedLogo = cleanUrl(getXmlTagText(headerChunk, 'logo'));
    const feedId = getXmlTagText(headerChunk, 'id');
    const feedSubLabel = getXmlAttr(headerChunk, 'category', 'label')
        || (getXmlAttr(headerChunk, 'category', 'term') ? `r/${getXmlAttr(headerChunk, 'category', 'term')}` : undefined);

    result.feedMeta = sanitizeRecord({
        title: feedTitle,
        subtitle: feedSubtitle,
        iconUrl: feedIcon,
        bannerUrl: feedLogo,
        subreddit: feedSubLabel,
        feedId
    });

    const maxItems = options.maxItems ?? 100;
    const maxComments = options.maxComments ?? 50;
    const defaultSubreddit = options.subreddit
        ? (options.subreddit.startsWith('r/') ? options.subreddit : `r/${options.subreddit}`)
        : feedSubLabel;

    const entryMatches = xmlText.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
    result.entriesCount = entryMatches.length;

    let parentPostId = options.postId;
    let parentPostTitle = options.postTitle;

    for (const entryXml of entryMatches) {
        const rawFullname = getXmlTagText(entryXml, 'id') || '';
        const authorBlock = entryXml.match(/<author>[\s\S]*?<\/author>/i)?.[0] || '';
        const authorNameTag = getXmlTagText(authorBlock, 'name') || '';
        const authorRaw = authorNameTag.replace(/^\/?u\//i, '').trim() || '[deleted]';
        const author = authorRaw !== '[deleted]' ? `u/${authorRaw}` : authorRaw;

        const entrySubLabel = getXmlAttr(entryXml, 'category', 'label')
            || (getXmlAttr(entryXml, 'category', 'term') ? `r/${getXmlAttr(entryXml, 'category', 'term')}` : undefined)
            || defaultSubreddit;

        const title = getXmlTagText(entryXml, 'title') || '';
        const entryLink = cleanUrl(getXmlAttr(entryXml, 'link', 'href'));
        const updated = getXmlTagText(entryXml, 'updated');
        const published = getXmlTagText(entryXml, 'published') || updated;
        const thumbnail = cleanUrl(getXmlAttr(entryXml, 'media:thumbnail', 'url'));
        const contentHtml = getXmlTagText(entryXml, 'content') || '';

        const scMatch = contentHtml.match(/<!--\s*SC_OFF\s*-->\s*<div class="md">([\s\S]*?)<\/div>\s*<!--\s*SC_ON\s*-->/i);
        const mdMatch = scMatch || contentHtml.match(/<div class="md">([\s\S]*?)<\/div>/i);
        const body = mdMatch ? stripHtmlTags(mdMatch[1]) : stripHtmlTags(
            contentHtml.replace(/<table>[\s\S]*?<\/table>/i, '')
        );

        const extLinkMatch = contentHtml.match(/<a href="([^"]+)">\[link\]<\/a>/i);
        const rawExternal = extLinkMatch ? cleanUrl(decodeHtmlEntities(extLinkMatch[1])) : undefined;
        const isCommentEntry = rawFullname.startsWith('t1_');

        if (isCommentEntry) {
            if (result.comments.length >= maxComments) continue;
            const commentId = rawFullname.slice(3);
            result.comments.push(sanitizeRecord({
                type: 'COMMENT',
                id: commentId || undefined,
                parentId: parentPostId ? `t3_${parentPostId}` : undefined,
                postId: parentPostId,
                postTitle: parentPostTitle,
                url: entryLink,
                author,
                authorRaw,
                body,
                depth: 0,
                source: 'reddit_rss',
                createdAt: published,
                scrapedAt: new Date().toISOString()
            }));
            continue;
        }

        const postIdMatch = rawFullname.match(/^t3_([a-z0-9]+)$/i) || entryLink?.match(/\/comments\/([a-z0-9]+)\//i);
        const postId = postIdMatch ? postIdMatch[1] : undefined;
        const fullname = postId ? `t3_${postId}` : (rawFullname || undefined);

        if (!parentPostId && postId) parentPostId = postId;
        if (!parentPostTitle && title) parentPostTitle = title;

        if (result.posts.length >= maxItems) continue;

        let postType = 'text';
        let mediaUrl = thumbnail;
        let externalUrl;

        if (rawExternal && rawExternal !== entryLink && !rawExternal.includes('reddit.com/r/')) {
            if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(rawExternal) || rawExternal.includes('i.redd.it')) {
                postType = 'image';
                mediaUrl = rawExternal;
            } else if (rawExternal.includes('v.redd.it')) {
                postType = 'video';
                mediaUrl = rawExternal;
            } else {
                postType = 'link';
                externalUrl = rawExternal;
            }
        } else if (thumbnail && /i\.redd\.it|preview\.redd\.it/i.test(thumbnail) && !body) {
            postType = 'image';
        }

        const combinedText = `${body}\n${externalUrl || ''}`;
        const emails = extractEmails(combinedText);
        const socialLinks = extractSocialLinks(combinedText);

        result.posts.push(sanitizeRecord({
            type: 'POST',
            id: postId,
            name: fullname,
            url: entryLink || rawExternal,
            title,
            body,
            author,
            authorRaw,
            subreddit: entrySubLabel,
            postType,
            mediaUrl,
            externalUrl,
            emails: emails.length > 0 ? emails : undefined,
            socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
            source: 'reddit_rss',
            createdAt: published,
            scrapedAt: new Date().toISOString()
        }));
    }

    return result;
}

export function buildSubredditFromRssFeed(feedMeta, subName) {
    if (!feedMeta) return null;
    const cleanName = feedMeta.subreddit || (subName ? (subName.startsWith('r/') ? subName : `r/${subName}`) : undefined);
    if (!cleanName) return null;

    const description = feedMeta.subtitle || '';
    const emails = extractEmails(description);
    const socialLinks = extractSocialLinks(description);

    return sanitizeRecord({
        type: 'SUBREDDIT',
        name: cleanName,
        url: `https://www.reddit.com/${cleanName}/`,
        title: feedMeta.title || subName,
        description,
        iconUrl: feedMeta.iconUrl,
        bannerUrl: feedMeta.bannerUrl,
        emails: emails.length > 0 ? emails : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
        source: 'reddit_rss',
        scrapedAt: new Date().toISOString()
    });
}

function readTagAttr(tag, attrName) {
    const regex = new RegExp(`\\b${attrName}=["']([^"']*)["']`, 'i');
    const m = tag.match(regex);
    return m ? decodeHtmlEntities(m[1]) : undefined;
}

// Parse <shreddit-post> / <shreddit-comment> elements if Playwright successfully loads HTML DOM
export function parseRedditHtmlDom(html, options = {}) {
    const out = { posts: [], comments: [] };
    if (!html || typeof html !== 'string') return out;

    const maxItems = options.maxItems ?? 100;
    const maxComments = options.maxComments ?? 50;

    const postTags = html.match(/<shreddit-post\b[^>]*>/gi) || [];
    for (const tag of postTags) {
        if (out.posts.length >= maxItems) break;
        const fullname = readTagAttr(tag, 'id') || '';
        const id = fullname.startsWith('t3_') ? fullname.slice(3) : fullname;
        const title = readTagAttr(tag, 'post-title') || '';
        const authorRaw = readTagAttr(tag, 'author') || '[deleted]';
        const subredditPrefixed = readTagAttr(tag, 'subreddit-prefixed-name')
            || (readTagAttr(tag, 'subreddit-name') ? `r/${readTagAttr(tag, 'subreddit-name')}` : undefined);
        const permalink = readTagAttr(tag, 'permalink');
        const contentHref = cleanUrl(readTagAttr(tag, 'content-href'));
        const score = parseSafeInt(readTagAttr(tag, 'score'), 0);
        const numComments = parseSafeInt(readTagAttr(tag, 'comment-count'), 0);
        const postTypeAttr = (readTagAttr(tag, 'post-type') || 'text').toLowerCase();
        const createdAt = readTagAttr(tag, 'created-timestamp');

        const url = permalink ? cleanUrl(permalink) : contentHref;
        const isExternal = contentHref && !contentHref.includes('reddit.com');

        out.posts.push(sanitizeRecord({
            type: 'POST',
            id: id || undefined,
            name: fullname || (id ? `t3_${id}` : undefined),
            url,
            title,
            body: '',
            author: authorRaw !== '[deleted]' ? `u/${authorRaw}` : authorRaw,
            authorRaw,
            subreddit: subredditPrefixed,
            score,
            numComments,
            postType: ['image', 'video', 'gallery', 'link', 'text'].includes(postTypeAttr) ? postTypeAttr : 'text',
            externalUrl: postTypeAttr === 'link' && isExternal ? contentHref : undefined,
            mediaUrl: ['image', 'video'].includes(postTypeAttr) ? contentHref : undefined,
            source: 'reddit_dom',
            createdAt,
            scrapedAt: new Date().toISOString()
        }));
    }

    if (out.posts.length === 0) {
        const searchAnchorRegex = /<a\b[^>]*data-testid=["']post-title(?:-text)?["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = searchAnchorRegex.exec(html)) !== null && out.posts.length < maxItems) {
            const anchorTag = m[0];
            const href = cleanUrl(readTagAttr(anchorTag, 'href'));
            const title = stripHtmlTags(m[1]) || readTagAttr(anchorTag, 'aria-label') || '';
            if (!href || !title) continue;
            const idMatch = href.match(/\/comments\/([a-z0-9]+)\//i);
            const subMatch = href.match(/\/r\/([^/?#]+)\//i);
            const postId = idMatch ? idMatch[1] : undefined;
            out.posts.push(sanitizeRecord({
                type: 'POST',
                id: postId,
                name: postId ? `t3_${postId}` : undefined,
                url: href,
                title,
                body: '',
                author: '[deleted]',
                authorRaw: '[deleted]',
                subreddit: subMatch ? `r/${subMatch[1]}` : undefined,
                postType: 'text',
                source: 'reddit_dom',
                scrapedAt: new Date().toISOString()
            }));
        }
    }

    const commentTags = html.match(/<shreddit-comment\b[^>]*>/gi) || [];
    for (const tag of commentTags) {
        if (out.comments.length >= maxComments) break;
        const fullname = readTagAttr(tag, 'thingid') || '';
        const id = fullname.startsWith('t1_') ? fullname.slice(3) : fullname;
        const parentId = readTagAttr(tag, 'parentid');
        const authorRaw = readTagAttr(tag, 'author') || '[deleted]';
        const permalink = cleanUrl(readTagAttr(tag, 'permalink'));
        const score = parseSafeInt(readTagAttr(tag, 'score'), 0);
        const depth = parseSafeInt(readTagAttr(tag, 'depth'), 0);

        out.comments.push(sanitizeRecord({
            type: 'COMMENT',
            id: id || undefined,
            parentId,
            postId: options.postId,
            postTitle: options.postTitle,
            url: permalink,
            author: authorRaw !== '[deleted]' ? `u/${authorRaw}` : authorRaw,
            authorRaw,
            body: '',
            score,
            depth,
            source: 'reddit_dom',
            scrapedAt: new Date().toISOString()
        }));
    }

    return out;
}
