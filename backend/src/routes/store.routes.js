const express = require('express');
const store = require('../services/store.service');

/**
 * Public storefront content: contact details, top-bar announcement and FAQs.
 * GET /api/store?lang=en|lg|sw|fr
 */
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const data = await store.getPublicStore(String(req.query.lang || 'en'));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
