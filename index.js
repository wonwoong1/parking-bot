require('dotenv').config();
const { App } = require('@slack/bolt');
const mhp = require('./mhp');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const approvers = process.env.SLACK_APPROVER_USER_IDS.split(',').map(s => s.trim());
const pending = new Map();

app.command('/parking', async ({ command, ack, respond }) => {
  await ack();
  const plateInput = command.text.trim();
  if (!plateInput) {
    await respond({ text: '사용법: `/parking 차량번호` (예: `/parking 8091`)' });
    return;
  }
  const plate4 = plateInput.replace(/\s/g, '').slice(-4);
  if (!/^\d{4}$/.test(plate4)) {
    await respond({ text: '❌ 차량번호 뒷 4자리 숫자를 입력해주세요.' });
    return;
  }

  await respond({ text: `🔍 *${plateInput}* 조회 중...` });

  const vehicle = await mhp.searchVehicle(plate4).catch(() => null);
  if (!vehicle) {
    await respond({ text: `❌ *${plateInput}* 차량이 현재 주차장에 없습니다.` });
    return;
  }

  const inTime = vehicle.inTime;
  const mins = Math.floor((Date.now() - inTime) / 60000);
  const timeStr = `${Math.floor(mins / 60)}시간 ${mins % 60}분`;
  const inTimeStr = new Date(inTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
  const recommended = mhp.pickDiscountItem(inTime);

  const reqId = `${command.user_id}_${Date.now()}`;
  pending.set(reqId, {
    requesterId: command.user_id,
    requesterName: command.user_name,
    plateNumber: vehicle.plateNumber,
    inId: vehicle._id || vehicle.inoutId,
    inOrderId: vehicle.inOrderId || vehicle.inoutId,
    inTime,
  });

  await app.client.chat.postMessage({
    channel: process.env.SLACK_APPROVER_CHANNEL,
    text: `🚗 주차권 발급 요청 - ${vehicle.plateNumber}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🚗 주차권 발급 요청' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*차량번호*\n${vehicle.plateNumber}` },
          { type: 'mrkdwn', text: `*요청자*\n${command.user_name}` },
          { type: 'mrkdwn', text: `*입차 시간*\n${inTimeStr}` },
          { type: 'mrkdwn', text: `*주차 시간*\n${timeStr}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: recommended.isLong ? '⚠️ *1시간 이상* 주차 → 유료(중복) 권장' : '✅ *1시간 미만* 주차 → 중복X 권장' },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*1시간 중복X(유료)* — 1시간 미만 주차 시' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '발급' },
          style: recommended.isLong ? 'default' : 'primary',
          action_id: `approve_short_${reqId}`,
          value: reqId,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*1시간 유료(중복)* — 시간 선택 후 발급:' },
      },
      {
        type: 'actions',
        elements: [1, 2, 3, 4, 5].map(n => ({
          type: 'button',
          text: { type: 'plain_text', text: `${n}시간` },
          style: recommended.isLong ? 'primary' : 'default',
          action_id: `approve_long_${n}_${reqId}`,
          value: reqId,
        })),
      },
      { type: 'divider' },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '❌ 거절' },
          style: 'danger',
          action_id: `reject_${reqId}`,
          value: reqId,
          confirm: {
            title: { type: 'plain_text', text: '거절 확인' },
            text: { type: 'mrkdwn', text: `*${vehicle.plateNumber}* 발급 요청을 거절할까요?` },
            confirm: { type: 'plain_text', text: '거절' },
            deny: { type: 'plain_text', text: '취소' },
          },
        }],
      },
    ],
  });

  await respond({ text: `✅ *${vehicle.plateNumber}* 주차권 발급 요청이 접수됐습니다. 승인자 확인 후 발급됩니다.` });
});

async function handleApprove(body, ack, itemType, count) {
  await ack();
  const actorId = body.user.id;
  if (!approvers.includes(actorId)) {
    await app.client.chat.postEphemeral({ channel: body.channel.id, user: actorId, text: '❌ 발급 권한이 없습니다.' });
    return;
  }
  const reqId = body.actions[0].value;
  const req = pending.get(reqId);
  if (!req) return;
  pending.delete(reqId);

  const discountItemId = itemType === 'short'
    ? process.env.MHP_DISCOUNT_ITEM_SHORT
    : process.env.MHP_DISCOUNT_ITEM_LONG;
  const itemName = itemType === 'short' ? '1시간 중복X(유료)' : `1시간 유료(중복) x${count}`;

  try {
    await mhp.applyDiscount(req.inId, req.inOrderId, discountItemId, count);
    const msg = `✅ *${req.plateNumber}* 주차권 발급 완료!\n• 권종: ${itemName}\n• 발급자: <@${actorId}>`;
    await app.client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: msg,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: msg } }],
    });
    await app.client.chat.postMessage({
      channel: req.requesterId,
      text: `✅ 주차권이 발급됐습니다!\n차량: *${req.plateNumber}*\n권종: ${itemName}`,
    });
  } catch (e) {
    await app.client.chat.postMessage({
      channel: body.channel.id,
      text: `❌ 발급 실패: ${e.response?.data?.resultMessage || e.message}`,
    });
  }
}

app.action(/^approve_short_/, async ({ body, ack }) => handleApprove(body, ack, 'short', 1));
app.action(/^approve_long_(\d+)_/, async ({ body, ack, action }) => {
  const count = parseInt(action.action_id.split('_')[2]);
  handleApprove(body, ack, 'long', count);
});
app.action(/^reject_/, async ({ body, ack }) => {
  await ack();
  const reqId = body.actions[0].value;
  const req = pending.get(reqId);
  if (!req) return;
  pending.delete(reqId);
  await app.client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `❌ 거절됨 (${req.plateNumber}) — <@${body.user.id}>`,
    blocks: [],
  });
  await app.client.chat.postMessage({
    channel: req.requesterId,
    text: `❌ *${req.plateNumber}* 주차권 발급 요청이 거절됐습니다.`,
  });
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log(`✅ Parking Bot running on port ${process.env.PORT || 3000}`);
})();