import dayjs from 'dayjs';
import * as R from 'ramda';
import { Response } from '../interfaces/Response';
import { TwitterAccountInfo } from '../interfaces/TwitterAccountInfo';
import {
  TwitterMedia,
  TwitterMediaBase,
  TwitterMediaGif,
  TwitterMediaPhoto,
  TwitterMediaVideo,
} from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { TwitterUser } from '../interfaces/TwitterUser';
import { request } from '../ipc/network';
import { useAppStateStore } from '../stores/app-state';
import { parseCookie } from '../utils/cookie';
import MediaType from '../enums/MediaType';

const HOST = 'x.com';

// X web GraphQL operations and flags, aligned with the current twscrape client.
const timelineFeatures = {
  articles_preview_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_media_download_video_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  rweb_video_timestamps_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_awards_web_tipping_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  tweet_with_visibility_results_prefer_gql_media_interstitial_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  verified_phone_label_enabled: false,
  view_counts_everywhere_api_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  premium_content_api_read_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: false,
  responsive_web_grok_share_attachment_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_analysis_button_from_backend: false,
  responsive_web_jetfuel_frame: false,
  rweb_video_screen_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
};

function getCommonHeaders(withCredentials = true): Record<string, string> {
  const cookies = useAppStateStore.getState().cookieString;
  return {
    'User-Agent': navigator.userAgent,
    Referer: `https://${HOST}`,
    ...(withCredentials
      ? {
          Authorization:
            'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          Cookie: cookies,
          'X-Csrf-Token': parseCookie(cookies)['ct0'],
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes',
        }
      : {}),
  };
}

function ensureResponse(response: Response) {
  if (response.status >= 400) {
    log.error(response);
    throw new Error(`Response error: status=${response.status}`);
  }
}

export async function getAccountInfo(
  cookieStringOverride?: string,
): Promise<TwitterAccountInfo> {
  const res = await request({
    method: 'GET',
    url: `https://${HOST}`,
    responseType: 'text',
    headers: R.mergeRight(getCommonHeaders(false), {
      Cookie: cookieStringOverride,
    }),
  });
  ensureResponse(res);
  const html = res.body as string;
  const nameMatch = html.match(/"screen_name":"(.*?)"/);
  if (nameMatch === null) throw new Error('Cannot find name in response');

  const avatarMatch = html.match(/"profile_image_url_https":"(.*?)"/);
  if (avatarMatch === null) throw new Error('Cannot find avatar in response');

  return {
    screenName: nameMatch[1],
    avatar: avatarMatch[1],
  };
}

export async function getUser(screenName: string): Promise<TwitterUser> {
  const resp = await request({
    method: 'GET',
    responseType: 'json',
    url: `https://${HOST}/i/api/graphql/AMIBMjtxEEATh4z8V9GtRg/UserByScreenName`,
    query: {
      features: JSON.stringify({
        ...timelineFeatures,
        hidden_profile_likes_enabled: true,
        subscriptions_feature_can_gift_premium: false,
        hidden_profile_subscriptions_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled:
          false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      }),
      fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: false }),
      variables: JSON.stringify({
        screen_name: screenName,
        withSafetyModeUserFields: true,
      }),
    },
    headers: getCommonHeaders(),
  });
  ensureResponse(resp);

  const user = R.path<any>(['data', 'user', 'result'], resp.body);
  if (!user?.rest_id || !(user.core?.screen_name || user.legacy?.screen_name)) {
    throw new Error('找不到该用户');
  }
  return mapTwitterUser(user);
}

function mapTwitterUser(user: any): TwitterUser {
  return {
    id: user?.rest_id,
    avatar: user?.avatar?.image_url || user?.legacy?.profile_image_url_https,
    name: user?.core?.name ?? user?.legacy?.name,
    screenName: user?.core?.screen_name ?? user?.legacy?.screen_name,
    mediaCount: user?.tweet_counts?.media_tweets ?? user?.legacy?.media_count,
    registerTime: dayjs(user?.core?.created_at ?? user?.legacy?.created_at),
  };
}

const mapTwitterPosts = (posts: any[]) => {
  const mapTwitterMedias = (medias: any[]) => {
    const toTwitterMediaBase: (v: any) => TwitterMediaBase = (v: any) => {
      return {
        id: v?.id_str,
        url: v?.media_url_https,
        width: v?.original_info?.width,
        height: v?.original_info?.height,
      };
    };

    const toPhoto: (v: any) => TwitterMediaPhoto = (v: any) => ({
      ...toTwitterMediaBase(v),
      type: MediaType.Photo,
    });

    const toVideo: (v: any) => TwitterMediaVideo = (v: any) => ({
      ...toTwitterMediaBase(v),
      type: MediaType.Video,
      videoInfo: {
        duration: v?.video_info?.duration_millis,
        variants: v?.video_info?.variants?.map?.((item: any) => ({
          bitrate: item?.bitrate,
          contentType: item?.content_type ?? item?.contentType,
          url: item?.url,
        })),
        aspectRatio: v?.video_info?.aspect_ratio,
      },
    });

    const toGif: (v: any) => TwitterMediaGif = (v: any) => ({
      ...toTwitterMediaBase(v),
      type: MediaType.Gif,
      videoInfo: {
        url: v?.video_info?.variants?.[0]?.url,
        aspectRatio: v?.video_info?.aspect_ratio,
      },
    });

    return R.pipe<any[], (TwitterMedia | null)[], TwitterMedia[]>(
      R.map<any, TwitterMedia | null>(
        R.cond<any, TwitterMedia | null>([
          [R.propEq('photo', 'type'), toPhoto],
          [R.propEq('video', 'type'), toVideo],
          [R.propEq('animated_gif', 'type'), toGif],
          [R.T, R.always(null)],
        ]),
      ),
      R.filter<TwitterMedia | null, TwitterMedia>(R.isNotNil),
    )(medias);
  };
  return R.map<any, TwitterPost>((item) => {
    const mediaGroups = [
      item.extended_entities?.media,
      item.legacy?.extended_entities?.media,
      item.entities?.media,
      item.legacy?.entities?.media,
    ];
    const medias = mediaGroups.find(
      (media) => Array.isArray(media) && media.length,
    );
    return {
      id: item.rest_id,
      views: R.isNotNil(item?.views?.count)
        ? Number(item.views.count)
        : undefined,
      createdAt: item.legacy?.created_at
        ? dayjs(item.legacy?.created_at)
        : undefined,
      bookmarkCount: item?.legacy?.bookmark_count,
      bookmarked: item?.legacy?.bookmarked,
      favoriteCount: item?.legacy?.favorite_count,
      favorited: item?.legacy?.favorited,
      fullText: item?.legacy?.full_text,
      lang: item?.legacy?.lang,
      possiblySensitive: item?.legacy?.possibly_sensitive,
      replyCount: item?.legacy?.reply_count,
      retweeted: item?.legacy?.retweeted,
      retweetCount: item?.legacy?.retweet_count,
      medias: medias ? mapTwitterMedias(medias) : undefined,
      tags: R.pipe<any, any[], string[]>(
        R.path<any>(['legacy', 'entities', 'hashtags']),
        R.ifElse(R.isNotNil, R.map(R.prop('text')), R.always([])),
      )(item),
      user: mapTwitterUser(item.core?.user_results?.result),
    };
  })(posts);
};

function parseTimeline(
  body: unknown,
  previousCursor?: string,
  skipRetweets = false,
) {
  const user = R.path<any>(['data', 'user', 'result'], body);
  const instructions =
    user?.timeline?.timeline?.instructions ??
    user?.timeline_v2?.timeline?.instructions;

  if (!Array.isArray(instructions)) {
    const message = R.path<string>(['errors', 0, 'message'], body);
    throw new Error(message || 'X 返回的响应缺少时间线');
  }

  const tweets = new Map<string, any>();
  let cursor: string | null = null;

  function addItem(item: any) {
    if (item?.cursorType === 'Bottom' && typeof item.value === 'string') {
      cursor = item.value;
    }

    const result = item?.tweet_results?.result;
    const tweet =
      result?.__typename === 'TweetWithVisibilityResults'
        ? result.tweet
        : result;
    if (!tweet?.rest_id || (tweet.__typename && tweet.__typename !== 'Tweet'))
      return;
    if (
      skipRetweets &&
      (tweet.retweeted_status_result || tweet.legacy?.retweeted_status_result)
    )
      return;
    tweets.set(tweet.rest_id, tweet);
  }

  function addEntry(entry: any) {
    const content = entry?.content;
    addItem(content?.itemContent ?? content);
    for (const moduleItem of content?.items ?? []) {
      addItem(moduleItem?.item?.itemContent);
    }
  }

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) addEntry(entry);
    if (instruction.type === 'TimelineReplaceEntry')
      addEntry(instruction.entry);
    for (const item of instruction.moduleItems ?? []) {
      addItem(item?.item?.itemContent);
    }
  }

  return {
    twitterPosts: mapTwitterPosts([...tweets.values()]).filter(
      (post) => post.medias?.length,
    ),
    cursor: cursor === previousCursor ? null : cursor,
  };
}

export async function getUserMedias(
  userId: string,
  cursor?: string,
  count = 20,
): Promise<{
  twitterPosts: TwitterPost[];
  cursor: string | null;
}> {
  const resp = await request({
    method: 'GET',
    url: `https://${HOST}/i/api/graphql/FjGqmSbAmWrp4U33SysuuQ/UserMedia`,
    responseType: 'json',
    query: {
      features: JSON.stringify(timelineFeatures),
      fieldToggles: JSON.stringify({ withArticlePlainText: false }),
      variables: JSON.stringify({
        userId,
        count,
        cursor,
        includePromotedContent: false,
        withClientEventToken: false,
        withBirdwatchNotes: false,
        withVoice: true,
        withV2Timeline: true,
      }),
    },
    headers: getCommonHeaders(),
  });
  ensureResponse(resp);

  return parseTimeline(resp.body, cursor);
}

export async function getUserTweets(
  userId: string,
  cursor?: string,
  count = 20,
): Promise<{
  twitterPosts: TwitterPost[];
  cursor: string | null;
}> {
  const resp = await request({
    method: 'GET',
    url: `https://${HOST}/i/api/graphql/OdBLACRZ0-9NikpJotaT7g/UserTweets`,
    responseType: 'json',
    query: {
      features: JSON.stringify(timelineFeatures),
      variables: JSON.stringify({
        userId,
        count,
        cursor,
        includePromotedContent: true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      }),
    },
    headers: getCommonHeaders(),
  });
  ensureResponse(resp);

  return parseTimeline(resp.body, cursor, true);
}
