
const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MONGO_URI = process.env.MONGO_URI; // MongoDB Atlas থেকে ফ্রি URI

let db, pagesCollection;
MongoClient.connect(MONGO_URI).then(client => {
  db = client.db('krs_bot');
  pagesCollection = db.collection('pages');
  console.log('DB Connected');
});

// ফেসবুক Webhook ভেরিফাই - সব পেজের জন্য একটাই
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// মেসেজ আসলে এইখানে হিট করবে
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const page_id = entry.id; // কোন পেজে মেসেজ আসছে
      const webhook_event = entry.messaging[0];
      const sender_psid = webhook_event.sender.id;

      // DB থেকে ওই পেজের ডাটা বের করি
      const pageData = await pagesCollection.findOne({ page_id: page_id });
      if (!pageData) return res.status(200).send('PAGE_NOT_FOUND');

      if (webhook_event.message && webhook_event.message.text) {
        const user_msg = webhook_event.message.text;

        // অ্যাডমিন কমান্ড চেক
        if (sender_psid === pageData.admin_id && (user_msg.startsWith('set ') || user_msg === 'on' || user_msg === 'off' || user_msg === 'help')) {
          await handleAdminCommand(user_msg, sender_psid, pageData);
          return res.status(200).send('EVENT_RECEIVED');
        }

        // বট অফ থাকলে শুধু অ্যাডমিনকে রিপ্লাই দিবে
        if (!pageData.bot_on && sender_psid!== pageData.admin_id) {
          return res.status(200).send('EVENT_RECEIVED');
        }

        const ai_reply = await getAIReply(user_msg, pageData);
        sendMessage(sender_psid, ai_reply, pageData.page_access_token);
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// নতুন পেজ অ্যাড করার API - আপনি কল করবেন
app.post('/add-page', async (req, res) => {
  const { page_id, page_access_token, admin_id } = req.body;
  const defaultConfig = {
    page_id,
    page_access_token,
    admin_id,
    dam: 'ইনবক্স করুন ভাই',
    product: 'আমাদের প্রোডাক্ট',
    number: 'পেজের নাম্বারে কল দেন',
    mood: 'বন্ধুর মতো',
    bot_on: true
  };
  await pagesCollection.updateOne({ page_id }, { $set: defaultConfig }, { upsert: true });
  res.json({ success: true, msg: 'Page Added' });
});

async function getAIReply(user_msg, config) {
  const system_prompt = `তুমি একজন বাংলাদেশি ${config.product} দোকানের ${config.mood} সেলসম্যান।
  দাম: ${config.dam}. অর্ডার নাম্বার: ${config.number}.
  নিয়ম: 1. রিপ্লাই 1-2 লাইনে দিবে 2. দাম জিজ্ঞেস করলে "${config.dam}" বলবে 3. অর্ডার করলে নাম, ঠিকানা, ফোন নিবে আর বলবে "${config.number} এ কনফার্ম করতে"`;

  try {
    const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {role: 'system', content: system_prompt},
        {role: 'user', content: user_msg}
      ],
      temperature: 0.7,
      max_tokens: 100
    }, {
      headers: {'Authorization': `Bearer ${DEEPSEEK_API_KEY}`}
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    return 'সরি ভাই, নেটওয়ার্ক স্লো। 1 মিনিট পর আবার ট্রাই করেন 🙏';
  }
}

async function handleAdminCommand(msg, sender_psid, config) {
  let updateData = {};
  if (msg.includes('set দাম')) {
    updateData.dam = msg.replace('set দাম', '').trim();
    sendMessage(sender_psid, `✅ দাম আপডেট: ${updateData.dam}`, config.page_access_token);
  }
  else if (msg.includes('set প্রোডাক্ট')) {
    updateData.product = msg.replace('set প্রোডাক্ট', '').trim();
    sendMessage(sender_psid, `✅ প্রোডাক্ট আপডেট: ${updateData.product}`, config.page_access_token);
  }
  else if (msg.includes('set নাম্বার')) {
    updateData.number = msg.replace('set নাম্বার', '').trim();
    sendMessage(sender_psid, `✅ নাম্বার আপডেট: ${updateData.number}`, config.page_access_token);
  }
  else if (msg.includes('set মুড')) {
    updateData.mood = msg.replace('set মুড', '').trim();
    sendMessage(sender_psid, `✅ মুড আপডেট: বট এখন ${updateData.mood} ভাবে কথা বলবে`, config.page_access_token);
  }
  else if (msg === 'off') {
    updateData.bot_on = false;
    sendMessage(sender_psid, `❌ বট বন্ধ। চালু করতে 'on' লিখুন`, config.page_access_token);
  }
  else if (msg === 'on') {
    updateData.bot_on = true;
    sendMessage(sender_psid, `✅ বট চালু`, config.page_access_token);
  }
  else if (msg === 'help') {
    sendMessage(sender_psid, `কমান্ড লিস্ট:\nset দাম 1200 টাকা\nset প্রোডাক্ট জুতা\nset নাম্বার 017xx\nset মুড প্রফেশনাল\non / off`, config.page_access_token);
  }

  if (Object.keys(updateData).length > 0) {
    await pagesCollection.updateOne({ page_id: config.page_id }, { $set: updateData });
  }
}

function sendMessage(sender_psid, response, page_access_token) {
  axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${page_access_token}`, {
    recipient: {id: sender_psid},
    message: {text: response}
  }).catch(err => console.log(err.response?.data));
}

app.listen(process.env.PORT || 3000, () => console.log('KRS Multi-Page Bot Running'));
