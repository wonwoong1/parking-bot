const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const BASE = process.env.MHP_GATEWAY;
const SITE = process.env.MHP_SITE_ID;

let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const form = new FormData();
  form.append('grant_type', 'password');
  form.append('username', process.env.MHP_EMAIL);
  form.append('password', process.env.MHP_PASSWORD);
  const res = await axios.post(`${BASE}/auth`, form, {
    headers: { actor: 'mhp.console', ...form.getHeaders() }
  });
  _token = res.data.access_token;
  _tokenExpiry = Date.now() + 55 * 60 * 1000;
  return _token;
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, actor: 'mhp.console', Accept: 'application/json' };
}

async function searchVehicle(plate4) {
  const token = await getToken();
  const now = Date.now();
  const res = await axios.get(`${BASE}/o.traffic/${SITE}`, {
    headers: headers(token),
    params: {
      sortBy: 'inTime-1',
      searchType: 'NOT_OUT',
      plateNumber: plate4,
      rows: 20,
    },
  });
  console.log('[MHP] searchVehicle response:', JSON.stringify(res.data, null, 2));
  const content = res.data?.data?.content;
  if (!content || content.length === 0) return null;
  return content[0];
}

async function applyDiscount(inId, inOrderId, discountItemId, applyCount = 1) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/stores.discountItems.use/${SITE}/${discountItemId}`,
    { inId, inOrderId, applyCount, memo: '' },
    { headers: headers(token) }
  );
  console.log('[MHP] applyDiscount response:', JSON.stringify(res.data));
  return res.data;
}

async function cancelDiscount(recordId, inId, inOrderId) {
  const token = await getToken();
  const res = await axios.put(
    `${BASE}/stores.discountItems.cancel/${SITE}/${recordId}`,
    null,
    { headers: headers(token), params: { inId, inOrderId } }
  );
  return res.data;
}

function pickDiscountItem(inTimeMs) {
  const mins = Math.floor((Date.now() - inTimeMs) / 60000);
  if (mins < 60) {
    return { id: process.env.MHP_DISCOUNT_ITEM_SHORT, name: '1시간 중복X(유료)', isLong: false };
  } else {
    return { id: process.env.MHP_DISCOUNT_ITEM_LONG, name: '1시간 유료(중복)', isLong: true };
  }
}

module.exports = { searchVehicle, applyDiscount, cancelDiscount, pickDiscountItem };