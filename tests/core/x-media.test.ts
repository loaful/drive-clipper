// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/core/extract.js';
import {
  appendMissingXMediaToMarkdown,
  extractXPostMedia,
  getXMediaDedupKey,
  isXUrl,
  normalizeXMediaUrl,
} from '../../src/core/x-media.js';

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function buildTweetCell(params: {
  handle: string;
  displayName: string;
  statusId: string;
  text: string;
  mediaHtml?: string;
  quotedHtml?: string;
  cardHtml?: string;
  avatarUrl?: string;
}): string {
  const avatar =
    params.avatarUrl ??
    `https://pbs.twimg.com/profile_images/1000001/${params.handle}_bigger.jpg`;
  return `
    <div data-testid="cellInnerDiv">
      <article data-testid="tweet">
        <div data-testid="Tweet-User-Avatar">
          <div data-testid="UserAvatar-Container-${params.handle}">
            <div style="background-image: url(&quot;${avatar}&quot;);"></div>
            <img src="${avatar}" alt="${params.displayName}" />
          </div>
        </div>
        <div data-testid="User-Name">
          <a href="/${params.handle}">${params.displayName}</a>
          <a href="/${params.handle}">@${params.handle}</a>
          <a href="/${params.handle}/status/${params.statusId}"><time datetime="2026-11-24T07:39:04.000Z">Nov 24</time></a>
        </div>
        <div data-testid="tweetText">
          <span>${params.text}</span>
          <img src="https://abs-0.twimg.com/emoji/v2/svg/1f525.svg" alt="🔥" />
        </div>
        ${params.mediaHtml ?? ''}
        ${params.cardHtml ?? ''}
        ${params.quotedHtml ?? ''}
      </article>
    </div>
  `;
}

describe('isXUrl, normalizeXMediaUrl & getXMediaDedupKey', () => {
  it('matches x.com and twitter.com variants and rejects other hosts', () => {
    expect(isXUrl('https://x.com/jakevin/status/2125132076768985501')).toBe(true);
    expect(isXUrl('https://twitter.com/jakevin/status/2125132076768985501')).toBe(true);
    expect(isXUrl('https://mobile.x.com/jakevin/status/123')).toBe(true);
    expect(isXUrl('https://www.twitter.com/jakevin/status/123')).toBe(true);
    expect(isXUrl('https://example.com/x.com/status/123')).toBe(false);
    expect(isXUrl('https://notx.com/jakevin/status/123')).toBe(false);
    expect(isXUrl('chrome://extensions')).toBe(false);
  });

  it('normalizes pbs.twimg.com/media URLs to name=large while preserving format and deduplicating all size variants', () => {
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/media/AbCdEfG?format=jpg&name=small'),
    ).toBe('https://pbs.twimg.com/media/AbCdEfG?format=jpg&name=large');
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/media/AbCdEfG?name=900x900&format=png'),
    ).toBe('https://pbs.twimg.com/media/AbCdEfG?name=large&format=png');
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/media/AbCdEfG.jpg:small'),
    ).toBe('https://pbs.twimg.com/media/AbCdEfG.jpg?name=large');

    // Card images and video thumbnails must preserve their exact CDN parameters
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/card_img/123456/hero?format=jpg&name=800x419'),
    ).toBe('https://pbs.twimg.com/card_img/123456/hero?format=jpg&name=800x419');
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/amplify_video_thumb/2125131559464550400/img/dylZ-R9_u72qGM9w.jpg'),
    ).toBe('https://pbs.twimg.com/amplify_video_thumb/2125131559464550400/img/dylZ-R9_u72qGM9w.jpg');

    // Avatars, banners, and emojis are rejected
    expect(
      normalizeXMediaUrl('https://pbs.twimg.com/profile_images/123/avatar_bigger.jpg'),
    ).toBeNull();
    expect(
      normalizeXMediaUrl('https://abs-0.twimg.com/emoji/v2/svg/1f525.svg'),
    ).toBeNull();
    expect(
      normalizeXMediaUrl('https://abs.twimg.com/rweb/ssr/default/v2/og/image.png'),
    ).toBeNull();

    // All variants of the same media ID share one canonical dedupKey (preserving case)
    const variants = [
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&name=small',
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&name=900x900',
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&name=large',
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?name=orig&format=webp',
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8.jpg',
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8.jpg:large',
    ];
    const keys = variants.map((v) => getXMediaDedupKey(v));
    expect(new Set(keys)).toEqual(new Set(['https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8']));
  });
});

describe('extractPage + x-media integration on X.com / Twitter.com', () => {
  it('extracts tweet photos with empty alt="" and missing alt attribute and normalizes to name=large', async () => {
    const url = 'https://x.com/alice/status/2125000000000000001';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>Alice on X</title></head>
        <body>
          <main>
            ${buildTweetCell({
              handle: 'alice',
              displayName: 'Alice',
              statusId: '2125000000000000001',
              text: 'Sharing two architecture screenshots without alt text.',
              mediaHtml: `
                <div data-testid="tweetPhoto">
                  <img src="https://pbs.twimg.com/media/EmptyAltOne?format=jpg&amp;name=small" alt="" />
                </div>
                <div data-testid="tweetPhoto">
                  <img src="https://pbs.twimg.com/media/MissingAltTwo?format=png&amp;name=medium" />
                </div>
              `,
            })}
          </main>
        </body>
      </html>`);

    const extracted = await extractPage(doc, url, { mode: 'full' });

    expect(extracted.site).toBe('X (Twitter)');
    expect(extracted.author).toBe('@alice');
    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://pbs.twimg.com/media/EmptyAltOne?format=jpg&name=large',
      'https://pbs.twimg.com/media/MissingAltTwo?format=png&name=large',
    ]);
    expect(extracted.images.map((i) => i.suggestedName)).toEqual([
      '01-emptyaltone',
      '02-missingalttwo',
    ]);
    expect(extracted.markdown).toContain(
      '![](https://pbs.twimg.com/media/EmptyAltOne?format=jpg&name=large)',
    );
    expect(extracted.markdown).toContain(
      '![](https://pbs.twimg.com/media/MissingAltTwo?format=png&name=large)',
    );
  });

  it('extracts all 4 photos in document order for a multi-photo tweet including CSS background-image fallback', async () => {
    const url = 'https://x.com/photographer/status/2125000000000000002';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>Photographer on X</title></head>
        <body>
          ${buildTweetCell({
            handle: 'photographer',
            displayName: 'Photo Lab',
            statusId: '2125000000000000002',
            text: 'Four frames from tonight.',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <div style="background-image: url(&quot;https://pbs.twimg.com/media/FrameOne111?format=jpg&amp;name=360x360&quot;);"></div>
                <img src="https://pbs.twimg.com/media/FrameOne111?format=jpg&amp;name=360x360" alt="" />
              </div>
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/FrameTwo222?format=jpg&amp;name=small" alt="Second frame" />
              </div>
              <div data-testid="tweetPhoto">
                <div style="filter: brightness(1); background-image: url('https://pbs.twimg.com/media/FrameThree333?format=webp&amp;name=medium');"></div>
              </div>
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/FrameFour444?format=png&amp;name=small" />
              </div>
            `,
          })}
        </body>
      </html>`);

    const extracted = await extractPage(doc, url, { mode: 'full' });

    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://pbs.twimg.com/media/FrameTwo222?format=jpg&name=large',
      'https://pbs.twimg.com/media/FrameOne111?format=jpg&name=large',
      'https://pbs.twimg.com/media/FrameThree333?format=webp&name=large',
      'https://pbs.twimg.com/media/FrameFour444?format=png&name=large',
    ]);
    // Ensure FrameTwo222 (already extracted by Defuddle via non-empty alt) was NOT duplicated
    const frameTwoMatches = extracted.markdown.match(/FrameTwo222/g) ?? [];
    expect(frameTwoMatches).toHaveLength(1);
    // extractXPostMedia itself preserves exact 1-2-3-4 DOM order
    const rawMedia = extractXPostMedia(doc, url);
    expect(rawMedia.map((m) => m.url)).toEqual([
      'https://pbs.twimg.com/media/FrameOne111?format=jpg&name=large',
      'https://pbs.twimg.com/media/FrameTwo222?format=jpg&name=large',
      'https://pbs.twimg.com/media/FrameThree333?format=webp&name=large',
      'https://pbs.twimg.com/media/FrameFour444?format=png&name=large',
    ]);
  });

  it('deduplicates name=small vs name=large when Defuddle already extracted a non-empty alt photo', async () => {
    const url = 'https://twitter.com/jakevin/status/2124554674804252853';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>jakevin on X</title></head>
        <body>
          ${buildTweetCell({
            handle: 'jakevin',
            displayName: '卡比卡比',
            statusId: '2124554674804252853',
            text: '自己做了一个设备。',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <div style="background-image: url(&quot;https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&amp;name=small&quot;);"></div>
                <img src="https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&amp;name=small" alt="图像" />
              </div>
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/SecondReversedOrder?name=small&amp;format=jpg" alt="Reversed params" />
              </div>
            `,
          })}
        </body>
      </html>`);

    const extracted = await extractPage(doc, url, { mode: 'full' });

    expect(extracted.images).toHaveLength(2);
    expect(extracted.images[0].resolvedUrl).toBe(
      'https://pbs.twimg.com/media/HXvvBo6aEAAcdQ8?format=jpg&name=large',
    );
    expect(extracted.markdown.match(/HXvvBo6aEAAcdQ8/g)).toHaveLength(1);
    expect(extracted.markdown.match(/SecondReversedOrder/g)).toHaveLength(1);
  });

  it('extracts video poster thumbnails and card images, inserting them before ## Comments', async () => {
    const url = 'https://x.com/jakevin/status/2125132076768985501';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>卡比卡比 on X</title></head>
        <body>
          ${buildTweetCell({
            handle: 'jakevin',
            displayName: '卡比卡比',
            statusId: '2125132076768985501',
            text: '用 HungerG 做了 Raft Build 分享 PPT，大家可以看看效果。',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <div data-testid="videoPlayer">
                  <div data-testid="videoComponent">
                    <video
                      aria-label="嵌入式视频"
                      poster="https://pbs.twimg.com/amplify_video_thumb/2125131559464550400/img/dylZ-R9_u72qGM9w.jpg"
                      src="blob:https://x.com/f842c844-2794-407b-95ab-2a1f13f5f011"
                    ></video>
                  </div>
                </div>
              </div>
            `,
            cardHtml: `
              <div data-testid="card.wrapper">
                <a href="https://t.co/cardlink" aria-label="Raft Build\nWorkspace for human and agent">
                  <img src="https://pbs.twimg.com/card_img/2125132076768985501/CardHeroImg?format=jpg&amp;name=800x419" alt="" />
                </a>
              </div>
            `,
          })}
          ${buildTweetCell({
            handle: 'ho_bevan',
            displayName: 'Bevan Ho',
            statusId: '2125135414650621976',
            text: '一個提示詞直出的話，它是自己去讀那些聊天紀錄嗎？',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/ReplyPhotoExcluded?format=jpg&amp;name=small" alt="" />
              </div>
            `,
          })}
          <div data-testid="cellInnerDiv"><h2>发现更多</h2></div>
          ${buildTweetCell({
            handle: 'jakevin',
            displayName: '卡比卡比',
            statusId: '2125133577730064887',
            text: '发现更多里的另一条帖子，不应该被抓取图片。',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/DiscoverMoreExcluded?format=jpg&amp;name=small" alt="" />
              </div>
            `,
          })}
        </body>
      </html>`);

    const extracted = await extractPage(doc, url, { mode: 'full' });

    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://pbs.twimg.com/amplify_video_thumb/2125131559464550400/img/dylZ-R9_u72qGM9w.jpg',
      'https://pbs.twimg.com/card_img/2125132076768985501/CardHeroImg?format=jpg&name=800x419',
    ]);
    expect(extracted.images[0].suggestedName).toBe('01-dylz-r9-u72qgm9w');
    expect(extracted.images[1].suggestedName).toBe('02-cardheroimg');

    // Video poster & card image appear BEFORE "## Comments", not after replies!
    const posterIdx = extracted.markdown.indexOf('dylZ-R9_u72qGM9w.jpg');
    const commentsIdx = extracted.markdown.indexOf('## Comments');
    expect(posterIdx).toBeGreaterThan(-1);
    expect(commentsIdx).toBeGreaterThan(posterIdx);

    // Strictly excludes reply photo, "Discover more" photo, avatars, and emojis
    expect(extracted.markdown).not.toContain('ReplyPhotoExcluded');
    expect(extracted.markdown).not.toContain('DiscoverMoreExcluded');
    expect(extracted.markdown).not.toContain('profile_images');
    expect(extracted.markdown).not.toContain('/emoji/');
  });

  it('includes consecutive self-thread tweets and quoted tweets while excluding replies and later author replies', async () => {
    const url = 'https://x.com/threadauthor/status/100';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>Thread Author on X</title></head>
        <body>
          ${buildTweetCell({
            handle: 'threadauthor',
            displayName: 'Thread Author',
            statusId: '100',
            text: '1/ Opening tweet with a photo and a quoted tweet.',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/MainTweetPic?format=jpg&amp;name=small" alt="" />
              </div>
            `,
            quotedHtml: `
              <div aria-labelledby="id__quoted1" role="link">
                <div data-testid="Tweet-User-Avatar">
                  <img src="https://pbs.twimg.com/profile_images/999/quoted_avatar.jpg" alt="Quoted" />
                </div>
                <div data-testid="User-Name"><span>Quoted User</span><span>@quoteduser</span></div>
                <div data-testid="tweetText"><span>Quoted post text</span></div>
                <div data-testid="tweetPhoto">
                  <img src="https://pbs.twimg.com/media/QuotedTweetPic?format=png&amp;name=medium" alt="" />
                </div>
              </div>
            `,
          })}
          ${buildTweetCell({
            handle: 'threadauthor',
            displayName: 'Thread Author',
            statusId: '101',
            text: '2/ Consecutive self-thread continuation.',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/SelfThreadPic?format=jpg&amp;name=small" alt="" />
              </div>
            `,
          })}
          ${buildTweetCell({
            handle: 'otheruser',
            displayName: 'Other User',
            statusId: '102',
            text: 'Unrelated reply from another user.',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/OtherReplyPic?format=jpg&amp;name=small" alt="" />
              </div>
            `,
          })}
          ${buildTweetCell({
            handle: 'threadauthor',
            displayName: 'Thread Author',
            statusId: '103',
            text: 'Author replying to Other User after thread already ended.',
            mediaHtml: `
              <div data-testid="tweetPhoto">
                <img src="https://pbs.twimg.com/media/LaterAuthorReplyPic?format=jpg&amp;name=small" alt="" />
              </div>
            `,
          })}
        </body>
      </html>`);

    const extracted = await extractPage(doc, url, { mode: 'full' });

    expect(extracted.images.map((i) => i.resolvedUrl)).toEqual([
      'https://pbs.twimg.com/media/MainTweetPic?format=jpg&name=large',
      'https://pbs.twimg.com/media/QuotedTweetPic?format=png&name=large',
      'https://pbs.twimg.com/media/SelfThreadPic?format=jpg&name=large',
    ]);
    expect(extracted.markdown).not.toContain('OtherReplyPic');
    expect(extracted.markdown).not.toContain('LaterAuthorReplyPic');
    expect(extracted.markdown).not.toContain('quoted_avatar.jpg');
  });

  it('supports redesigned X DOM without data-testid attributes and does not inject media in selection mode', async () => {
    const url = 'https://x.com/redesignuser/status/3000000000000000001';
    const doc = parseHtml(`<!doctype html>
      <html>
        <head><title>Redesign Post</title></head>
        <body>
          <ul>
            <li>
              <article>
                <a href="/redesignuser">Redesign User</a>
                <a href="/redesignuser/status/3000000000000000001">Nov 24</a>
                <img src="https://pbs.twimg.com/profile_images/77/av.jpg" alt="Redesign User" />
                <div dir="auto" lang="en" id="sel-target">Redesigned X post text with an alt-less photo.</div>
                <img src="https://pbs.twimg.com/media/RedesignPhoto1?format=jpg&amp;name=small" alt="" />
              </article>
            </li>
            <li><h2>Discover more</h2></li>
            <li>
              <article>
                <a href="/redesignuser/status/3000000000000000099">Nov 23</a>
                <div dir="auto" lang="en">Unrelated discover-more post.</div>
                <img src="https://pbs.twimg.com/media/RedesignDiscoverExcluded?format=jpg&amp;name=small" alt="" />
              </article>
            </li>
          </ul>
        </body>
      </html>`);

    const media = extractXPostMedia(doc, url);
    expect(media.map((m) => m.url)).toEqual([
      'https://pbs.twimg.com/media/RedesignPhoto1?format=jpg&name=large',
    ]);

    // Selection mode on the live document must not inject unselected tweet images
    document.body.innerHTML = doc.body.innerHTML;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('sel-target')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = await extractPage(document, url, { mode: 'selection', selection });
    expect(selected.mode).toBe('selection');
    expect(selected.markdown).toContain('Redesigned X post text');
    expect(selected.images).toEqual([]);
    selection.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('handles image-only tweets with empty Markdown cleanly', () => {
    const merged = appendMissingXMediaToMarkdown(
      '',
      [
        {
          url: 'https://pbs.twimg.com/media/OnlyImage1?format=jpg&name=large',
          sourceUrl: 'https://pbs.twimg.com/media/OnlyImage1?format=jpg&name=small',
          dedupKey: 'https://pbs.twimg.com/media/OnlyImage1',
          alt: 'Chart [v1]',
          kind: 'photo',
        },
      ],
      'https://x.com/user/status/1',
    );
    expect(merged).toBe(
      '![Chart \\[v1\\]](https://pbs.twimg.com/media/OnlyImage1?format=jpg&name=large)',
    );
  });
});
