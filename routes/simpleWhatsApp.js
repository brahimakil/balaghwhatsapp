const express = require('express');
const router = express.Router();

// 🔗 CONNECT WHATSAPP
router.post('/connect', async (req, res) => {
  try {
    const result = await req.whatsappService.connect();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🛑 DISCONNECT WHATSAPP
router.post('/disconnect', async (req, res) => {
  try {
    await req.whatsappService.disconnect();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📇 GET CONTACTS
router.get('/contacts', async (req, res) => {
  try {
    const contacts = await req.whatsappService.getContacts();
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ➕ ADD CONTACT
router.post('/contacts', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const result = await req.whatsappService.addContact(name, phone, email);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📥 IMPORT CONTACTS
router.post('/contacts/import', async (req, res) => {
  try {
    const { csvData } = req.body;
    const result = await req.whatsappService.importContacts(csvData);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 EXPORT CONTACTS
router.get('/contacts/export', async (req, res) => {
  try {
    const csv = await req.whatsappService.exportContacts();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 👥 GET GROUPS
router.get('/groups', async (req, res) => {
  try {
    const groups = await req.whatsappService.getGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ➕ CREATE GROUP
router.post('/groups', async (req, res) => {
  try {
    const { groupName, contactIds } = req.body;
    const result = await req.whatsappService.createGroup(groupName, contactIds);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 SEND TO GROUP
router.post('/groups/:groupId/send', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { message } = req.body;
    const result = await req.whatsappService.sendToGroup(groupId, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
