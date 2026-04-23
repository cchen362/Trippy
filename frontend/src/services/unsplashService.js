import { request } from './api.js';

export const unsplashService = {
  search: (query) => request(`/api/lookups/photos?q=${encodeURIComponent(query)}`),
};
