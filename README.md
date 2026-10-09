# 🤖 Reddit Ultimate Scraper (Posts, Comments, Subreddits & Users)

Comprehensive, high-speed, all-in-one Reddit scraper on Apify. Extract **Posts** (with markdown body, images, videos, galleries, and external links), **Nested Threaded Comments & Replies**, **Subreddit Metrics & Rules**, **User Profiles & Karma**, and **Keyword Search** across Reddit.

---

## ⚡ Key Features

- 📑 **Complete Post Metadata**: Full post title, selftext markdown body, author (`u/author`), upvotes/score, upvote ratio, comments count, post flair, and timestamps.
- 🖼️ **Full Media Extraction**: Handles Reddit Videos (with audio/video streams), image galleries (`i.redd.it`), single images, and external article URLs.
- 💬 **Threaded Comments & Replies**: Recursively extracts nested comment trees with upvote scores, OP badges, moderator tags, and parent-child hierarchy.
- 👥 **Subreddit Intelligence**: Scrapes community subscriber counts, active users currently online, community descriptions, and official subreddit rules.
- 👤 **User Profiles & Karma**: Extract user bio, total karma, post karma, comment karma, account age, and verified badges.
- 🔎 **Deep Search & Time Filters**: Search across Reddit or inside specific subreddits with filters (`hot`, `new`, `top`, `rising`, `relevance`) and time frames (`hour`, `day`, `week`, `month`, `year`, `all`).
- 📧 **Lead Generation**: Automatically extracts business emails and social media links (Twitter/X, Instagram, TikTok, LinkedIn, Discord, GitHub) mentioned in posts or bios.
- 🛡️ **Dual-Engine Speed & Reliability**: Fast direct JSON API queries backed by a Playwright headless browser fallback for anti-bot resilience.

---

## 📥 Input Configuration

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mode` | String | `AUTO_DETECT` | Scraping mode: `AUTO_DETECT`, `POSTS`, `COMMENTS`, `SUBREDDITS`, `USERS`, `SEARCH`. |
| `targetUrls` | Array | `[...]` | List of Subreddit URLs, Post URLs, or User profile URLs. |
| `searchQueries` | Array | `[]` | Keywords to search across Reddit when using `SEARCH` mode. |
| `sort` | String | `"hot"` | Sorting method: `hot`, `new`, `top`, `rising`, `relevance`. |
| `timeFilter` | String | `"all"` | Time frame: `all`, `year`, `month`, `week`, `day`, `hour`. |
| `maxItems` | Integer | `50` | Maximum posts, search results, or items to scrape. |
| `maxComments` | Integer | `30` | Maximum comments and replies per post. |
| `includeComments`| Boolean | `true` | Automatically extract top comments alongside posts. |
| `proxyConfiguration` | Object | `{ useApifyProxy: true }` | Apify Residential proxy configuration (recommended). |

---

## 📤 Output Data Format

### 1. Reddit Post Record

```json
{
  "type": "POST",
  "id": "1bcxyz",
  "name": "t3_1bcxyz",
  "url": "https://www.reddit.com/r/technology/comments/1bcxyz/new_breakthrough_in_ai/",
  "title": "New Breakthrough in AI Architecture Revealed",
  "body": "Researchers have published a new transformer alternative that operates in linear time...",
  "author": "u/tech_enthusiast",
  "subreddit": "r/technology",
  "score": 4520,
  "upvoteRatio": 0.94,
  "numComments": 380,
  "postType": "text",
  "flair": "Artificial Intelligence",
  "isNsfw": false,
  "isStickied": false,
  "emails": ["researcher@lab.org"],
  "socialLinks": [
    { "platform": "github", "url": "https://github.com/open-research/model" }
  ],
  "createdAt": "2026-10-09T08:30:00.000Z",
  "scrapedAt": "2026-10-09T10:45:00.000Z"
}
```

### 2. Threaded Comment Record

```json
{
  "type": "COMMENT",
  "id": "m1n2o3",
  "parentId": "t3_1bcxyz",
  "url": "https://www.reddit.com/r/technology/comments/1bcxyz/comment/m1n2o3/",
  "author": "u/datascience_guy",
  "body": "This could significantly reduce compute costs for edge deployment.",
  "score": 312,
  "depth": 0,
  "isOp": false,
  "createdAt": "2026-10-09T09:15:00.000Z",
  "scrapedAt": "2026-10-09T10:45:00.000Z"
}
```

### 3. Subreddit Record

```json
{
  "type": "SUBREDDIT",
  "id": "2qh16",
  "name": "r/technology",
  "url": "https://www.reddit.com/r/technology/",
  "title": "Technology",
  "description": "A community dedicated to the news and discussions about the creation and use of technology...",
  "subscribers": 16500000,
  "activeUsers": 4200,
  "isNsfw": false,
  "iconUrl": "https://styles.redditmedia.com/...",
  "scrapedAt": "2026-10-09T10:45:00.000Z"
}
```

---

## 🤖 AI & LLM Use Cases

- **Sentiment Analysis & Brand Monitoring**: Analyze public sentiment towards companies, products, or competitors in real-time.
- **LLM Pretraining & RAG Pipelines**: Feed authentic community discussions and Q&As into retrieval-augmented generation models.
- **Trend Spotting & Market Research**: Identify emerging consumer problems and viral topics before they hit mainstream media.

---

## 📄 License
Apache-2.0
