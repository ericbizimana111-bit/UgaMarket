import { useEffect, useState } from 'react';
import apiClient from '../api/client';
import { useLanguage } from '../Context/LanguageContext';

/**
 * Admin-managed storefront content: contact details, top-bar announcement
 * and FAQs (GET /api/store). The header, footer and help page all need it, so
 * one request per language is cached for the lifetime of the page.
 */
const EMPTY = { store: null, faqs: [] };
const cache = new Map(); // lang -> Promise<{ store, faqs }>

function fetchStoreInfo(lang) {
  if (!cache.has(lang)) {
    const promise = apiClient
      .get(`/store?lang=${lang}`)
      .then((res) => ({ store: res?.data?.store || null, faqs: Array.isArray(res?.data?.faqs) ? res.data.faqs : [] }))
      .catch(() => {
        cache.delete(lang); // allow a retry on the next mount
        return EMPTY;
      });
    cache.set(lang, promise);
  }
  return cache.get(lang);
}

/** "+256772123456" -> "+256 772 123 456" (other formats are returned as-is). */
export function formatUgPhone(phone) {
  const m = /^\+256(\d{3})(\d{3})(\d{3})$/.exec(phone || '');
  return m ? `+256 ${m[1]} ${m[2]} ${m[3]}` : phone || '';
}

export default function useStoreInfo() {
  const { currentLang } = useLanguage();
  const [state, setState] = useState({ lang: null, ...EMPTY });

  useEffect(() => {
    let active = true;
    fetchStoreInfo(currentLang).then((data) => {
      if (active) setState({ lang: currentLang, ...data });
    });
    return () => {
      active = false;
    };
  }, [currentLang]);

  return { store: state.store, faqs: state.faqs, loading: state.lang !== currentLang };
}
