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

// ✅ CHECK CONNECTION STATUS
router.get('/status', (req, res) => {
  try {
    const isConnected = req.whatsappService.isWhatsAppConnected();
    res.json({ connected: isConnected });
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

// 🗑️ DELETE CONTACT
router.delete('/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await req.whatsappService.deleteContact(id);
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

// 🗑️ DELETE GROUP
router.delete('/groups/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await req.whatsappService.deleteGroup(id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 SEND TO SINGLE CONTACT
router.post('/send/contact/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const result = await req.whatsappService.sendToContact(id, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 SEND TO MULTIPLE CONTACTS
router.post('/send/contacts', async (req, res) => {
  try {
    const { contactIds, message } = req.body;
    const result = await req.whatsappService.sendToContacts(contactIds, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 SEND TO GROUP
router.post('/send/group/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const result = await req.whatsappService.sendToGroup(id, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📤 SEND TO MIXED SELECTION (contacts + groups)
router.post('/send/selection', async (req, res) => {
  try {
    const { contactIds, groupIds, message } = req.body;
    const result = await req.whatsappService.sendToSelection(contactIds, groupIds, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
