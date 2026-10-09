/**
 * Reddit Ultimate Scraper - High-Speed Extractors
 * Robust parsing for Posts, Nested Comments, Subreddits, Users, and Media.
 */

// Helper to extract email addresses
export function extractEmails(text) {
    if (!text || typeof text !== 'string') return [];
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const matches = text.match(emailRegex) || [];
    const ignored = ['reddit.com', 'redditmedia.com', 'example.com'];
    const unique = [...new Set(matches.map(m => m.trim().toLowerCase()))];
    return unique.filter(e => !ignored.some(d => e.endsWith(`@${d}`)));
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

// Unescape Reddit encoded URLs (e.g. &amp; -> &)
export function cleanUrl(url) {
    if (!url || typeof url !== 'string') return null;
    return url.replace(/&amp;/g, '&');
}

// Parse a single Reddit post object
export function parsePostItem(postData) {
    if (!postData || typeof postData !== 'object') return null;

    const id = postData.id;
    const name = postData.name || `t3_${id}`;
    const title = postData.title || '';
    const body = postData.selftext || '';
    const author = postData.author || '[deleted]';
    const subreddit = postData.subreddit ? `r/${postData.subreddit}` : null;
    const subredditId = postData.subreddit_id || null;
    const score = postData.score ?? 0;
    const upvoteRatio = postData.upvote_ratio ?? 1.0;
    const numComments = postData.num_comments ?? 0;
    const permalink = postData.permalink ? `https://www.reddit.com${postData.permalink}` : null;
    const rawUrl = postData.url || permalink;
    const flair = postData.link_flair_text || null;
    const isNsfw = Boolean(postData.over_18);
    const isSpoiler = Boolean(postData.spoiler);
    const isStickied = Boolean(postData.stickied);
    const isLocked = Boolean(postData.locked);

    // Media & Post Type classification
    let postType = 'text';
    let mediaUrl = null;
    let galleryUrls = [];
    let videoUrl = null;
    let externalUrl = null;

    // 1. Video
    if (postData.is_video && postData.media?.reddit_video?.fallback_url) {
        postType = 'video';
        videoUrl = cleanUrl(postData.media.reddit_video.fallback_url);
        mediaUrl = videoUrl;
    }
    // 2. Image Gallery
    else if (postData.is_gallery && postData.gallery_data?.items) {
        postType = 'gallery';
        for (const item of postData.gallery_data.items) {
            const mediaId = item.media_id;
            if (mediaId) {
                galleryUrls.push(`https://i.redd.it/${mediaId}.jpg`);
            }
        }
        mediaUrl = galleryUrls[0] || null;
    }
    // 3. Single Image
    else if (rawUrl && (rawUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i) || rawUrl.includes('i.redd.it'))) {
        postType = 'image';
        mediaUrl = cleanUrl(rawUrl);
    }
    // 4. External link
    else if (rawUrl && !rawUrl.includes('reddit.com') && !rawUrl.includes('redd.it')) {
        postType = 'link';
        externalUrl = cleanUrl(rawUrl);
        if (postData.preview?.images?.[0]?.source?.url) {
            mediaUrl = cleanUrl(postData.preview.images[0].source.url);
        }
    } else {
        postType = 'text';
    }

    const createdUtc = postData.created_utc ? new Date(postData.created_utc * 1000).toISOString() : null;
    const emails = extractEmails(body);
    const socialLinks = extractSocialLinks(body);

    return {
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
        videoUrl: videoUrl || undefined,
        externalUrl: externalUrl || undefined,
        emails: emails.length > 0 ? emails : undefined,
        socialLinks: socialLinks.length > 0 ? socialLinks : undefined,
        createdAt: createdUtc,
        scrapedAt: new Date().toISOString()
    };
}

// Parse recursive comments tree
export function parseCommentsTree(commentChildren, maxComments = 50, currentDepth = 0) {
    const comments = [];

    function traverse(children, depth) {
        if (!Array.isArray(children)) return;

        for (const item of children) {
            if (comments.length >= maxComments) break;
            if (item.kind !== 't1' || !item.data) continue;

            const c = item.data;
            const author = c.author || '[deleted]';
            const body = c.body || '';
            const createdUtc = c.created_utc ? new Date(c.created_utc * 1000).toISOString() : null;

            comments.push({
                type: 'COMMENT',
                id: c.id,
                parentId: c.parent_id,
                url: c.permalink ? `https://www.reddit.com${c.permalink}` : null,
                author: author !== '[deleted]' ? `u/${author}` : author,
                authorRaw: author,
                body,
                score: c.score ?? 0,
                depth,
                isOp: Boolean(c.is_submitter),
                isStickied: Boolean(c.stickied),
                distinguished: c.distinguished || null,
                createdAt: createdUtc,
                scrapedAt: new Date().toISOString()
            });

            // Recurse into replies if present
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

    const name = subData.display_name ? `r/${subData.display_name}` : null;
    const title = subData.title || '';
    const description = subData.public_description || subData.description || '';
    const subscribers = subData.subscribers ?? 0;
    const activeUsers = subData.active_user_count ?? 0;
    const isNsfw = Boolean(subData.over18);
    const createdUtc = subData.created_utc ? new Date(subData.created_utc * 1000).toISOString() : null;
    const iconUrl = cleanUrl(subData.community_icon || subData.icon_img);
    const bannerUrl = cleanUrl(subData.banner_background_image || subData.banner_img);

    // Extract community rules if provided
    const rules = [];
    if (rulesData?.rules && Array.isArray(rulesData.rules)) {
        for (const r of rulesData.rules) {
            rules.push({
                priority: r.priority,
                shortName: r.short_name,
                description: r.description
            });
        }
    }

    const emails = extractEmails(description);
    const socialLinks = extractSocialLinks(description);

    return {
        type: 'SUBREDDIT',
        id: subData.id || subData.name,
        name,
        url: `https://www.reddit.com/${name}/`,
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
        createdAt: createdUtc,
        scrapedAt: new Date().toISOString()
    };
}

// Parse User profile data
export function parseUserData(userData) {
    if (!userData || typeof userData !== 'object') return null;

    const username = userData.name ? `u/${userData.name}` : null;
    const totalKarma = userData.total_karma ?? 0;
    const postKarma = userData.link_karma ?? 0;
    const commentKarma = userData.comment_karma ?? 0;
    const isGold = Boolean(userData.is_gold);
    const isVerified = Boolean(userData.verified);
    const createdUtc = userData.created_utc ? new Date(userData.created_utc * 1000).toISOString() : null;
    const bio = userData.subreddit?.public_description || '';
    const iconUrl = cleanUrl(userData.icon_img);
    const bannerUrl = cleanUrl(userData.subreddit?.banner_img);

    const emails = extractEmails(bio);
    const socialLinks = extractSocialLinks(bio);

    return {
        type: 'USER',
        id: userData.id,
        username,
        url: `https://www.reddit.com/user/${userData.name}/`,
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
        createdAt: createdUtc,
        scrapedAt: new Date().toISOString()
    };
}
