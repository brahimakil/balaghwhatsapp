const express = require('express');
const router = express.Router();

// Middleware to get WhatsApp service instance
router.use((req, res, next) => {
  const whatsappService = req.app.get('whatsappService'); // Get the single instance
  if (!whatsappService) {
    return res.status(500).json({ error: 'WhatsApp service not initialized' });
  }
  req.whatsappService = whatsappService;
  next();
});

// Connect to WhatsApp
router.post('/connect', async (req, res) => {
  try {
    const { sessionId, adminEmail } = req.body;
    
    console.log(`📱 Connect request - SessionId: ${sessionId}, Admin: ${adminEmail}`);
    
    const result = await req.whatsappService.createSession(sessionId, adminEmail);
    res.json(result);
    
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send single message
router.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phoneNumber, message, adminEmail } = req.body;
    
    const result = await req.whatsappService.sendMessage(
      sessionId, 
      phoneNumber, 
      message
    );
    res.json(result);
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send bulk messages
router.post('/send-bulk', async (req, res) => {
  try {
    const { sessionId, phoneNumbers, message, adminEmail } = req.body;
    
    console.log(`📤 Bulk send request - SessionId: ${sessionId}, Numbers: ${phoneNumbers.length}`);
    
    const result = await req.whatsappService.sendBulkMessages(
      sessionId, 
      phoneNumbers, 
      message, 
      adminEmail
    );
    res.json(result);
    
  } catch (error) {
    console.error('Bulk send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create group
router.post('/create-group', async (req, res) => {
  try {
    const { sessionId, groupName, phoneNumbers, adminEmail } = req.body;
    
    const result = await req.whatsappService.createGroup(
      sessionId, 
      groupName, 
      phoneNumbers, 
      adminEmail
    );
    res.json(result);
    
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all sessions
router.get('/sessions', async (req, res) => {
  try {
    console.log('📋 Sessions request received');
    const sessions = await req.whatsappService.getSessions();
    console.log(`📋 Returning ${sessions.length} sessions`);
    res.json(sessions);
    
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect session
router.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const result = await req.whatsappService.disconnectSession(sessionId);
    res.json(result);
    
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logout session (clear auth data)
router.post('/logout', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const result = await req.whatsappService.logoutSession(sessionId);
    res.json(result);
    
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore sessions
router.post('/restore', async (req, res) => {
  try {
    await req.whatsappService.restoreAllSessions();
    res.json({ success: true, message: 'Sessions restoration initiated' });
    
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get session status
router.get('/session-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const status = await req.whatsappService.getSessionStatus(sessionId);
    res.json(status);
    
  } catch (error) {
    console.error('Session status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all groups
router.get('/groups', async (req, res) => {
  try {
    console.log('👥 Groups request received');
    const groups = await req.whatsappService.getGroups();
    console.log(`👥 Returning ${groups.length} groups`);
    res.json(groups);
    
  } catch (error) {
    console.error('Get groups error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send message to group
router.post('/send-group-message', async (req, res) => {
  try {
    const { sessionId, groupId, message, adminEmail } = req.body;
    
    console.log(`👥 Group message request - SessionId: ${sessionId}, GroupId: ${groupId}`);
    
    const result = await req.whatsappService.sendGroupMessage(
      sessionId,
      groupId,
      message,
      adminEmail
    );
    res.json(result);
    
  } catch (error) {
    console.error('Group message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check active clients
router.get('/debug', (req, res) => {
  try {
    const activeSessions = req.whatsappService.getAllSessions();
    const clientsMap = req.whatsappService.clients; // Access the Map directly for debugging
    
    res.json({
      timestamp: new Date(),
      activeSessionsFromMap: activeSessions,
      clientsMapSize: clientsMap.size,
      clientsMapKeys: Array.from(clientsMap.keys()),
      message: 'Debug info retrieved successfully'
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;