declare module 'instagram-url-direct' {
  interface InstagramResponse {
    url_list?: string[];
  }

  function instagramGetUrl(url: string): Promise<InstagramResponse>;
  export default instagramGetUrl;
} 