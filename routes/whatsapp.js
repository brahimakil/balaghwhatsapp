const express = require('express');
const router = express.Router();

// Middleware to get WhatsApp service instance
router.use((req, res, next) => {
  // Change from: const whatsappService = req.app.get('whatsappService');
  // To: Use the service attached by server.js middleware
  const whatsappService = req.whatsappService;
  
  if (!whatsappService) {
    return res.status(500).json({ error: 'WhatsApp service not initialized' });
  }
  req.whatsappService = whatsappService; // This line is now redundant but harmless
  next();
});

// Add this route at the very beginning for debugging - add after line 13
router.get('/test', (req, res) => {
  res.json({ 
    message: 'WhatsApp routes are working!', 
    timestamp: new Date().toISOString(),
    availableRoutes: [
      'GET /api/whatsapp/sessions',
      'GET /api/whatsapp/whatsapp-contacts/:sessionId', 
      'GET /api/whatsapp/whatsapp-groups/:sessionId',
      'POST /api/whatsapp/send-bulk-chats'
    ]
  });
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

// Get all chats (contacts and groups) from WhatsApp
router.get('/chats/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('📋 Chats request received for session:', sessionId);
    
    const chats = await req.whatsappService.getChats(sessionId);
    console.log(`📋 Returning ${chats.length} chats`);
    res.json(chats);
    
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get WhatsApp groups from connected client
router.get('/whatsapp-groups/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('👥 WhatsApp groups request received for session:', sessionId);
    
    const groups = await req.whatsappService.getWhatsAppGroups(sessionId);
    console.log(`👥 Returning ${groups.length} WhatsApp groups`);
    res.json(groups);
    
  } catch (error) {
    console.error('Get WhatsApp groups error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get WhatsApp contacts from connected client
router.get('/whatsapp-contacts/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('👤 WhatsApp contacts request received for session:', sessionId);
    
    const contacts = await req.whatsappService.getWhatsAppContacts(sessionId);
    console.log(`👤 Returning ${contacts.length} WhatsApp contacts`);
    res.json(contacts);
    
  } catch (error) {
    console.error('Get WhatsApp contacts error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send bulk messages to selected chats
router.post('/send-bulk-chats', async (req, res) => {
  try {
    const { sessionId, message, selectedChats, delayBetweenMessages = 3, adminEmail } = req.body;
    
    console.log(`📤 Bulk chat message request - SessionId: ${sessionId}, Chats: ${selectedChats.length}`);
    
    const result = await req.whatsappService.sendBulkMessagesToChats(
      sessionId, 
      message,
      selectedChats,
      delayBetweenMessages,
      adminEmail
    );
    res.json(result);
    
  } catch (error) {
    console.error('Bulk chat message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force refresh endpoint for testing
router.post('/refresh/:sessionId', async (req, res) => {
  console.log('\n🔄 Manual refresh requested');
  try {
    const { sessionId } = req.params;
    
    const chats = await req.whatsappService.getChats(sessionId);
    console.log(`🔄 Refresh found ${chats.length} chats for session ${sessionId}`);
    
    res.json({ 
      success: true,
      message: 'Refresh completed', 
      chatCount: chats.length,
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error refreshing:', error);
    res.status(500).json({ error: 'Failed to refresh' });
  }
});

// Add this route for session health check
router.get('/health/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log('🏥 Session health check requested for:', sessionId);
    
    const health = await req.whatsappService.checkSessionHealth(sessionId);
    res.json(health);
    
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ healthy: false, error: error.message });
  }
});

// Add this route before module.exports (around line 334)
router.post('/destroy-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    console.log(`🗑️ Destroying session: ${sessionId}`);
    
    // Get the client and destroy it properly
    const client = req.whatsappService.clients.get(sessionId);
    if (client) {
      console.log(`🗑️ Found client for session ${sessionId}, destroying...`);
      try {
        await client.destroy();
        console.log(`✅ Client destroyed for session ${sessionId}`);
      } catch (destroyError) {
        console.error(`❌ Error destroying client for ${sessionId}:`, destroyError);
        // Continue anyway to clean up
      }
      
      // Force remove from clients map
      req.whatsappService.clients.delete(sessionId);
      console.log(`🗑️ Removed session ${sessionId} from clients map. Remaining clients: ${req.whatsappService.clients.size}`);
    } else {
      console.log(`⚠️ No client found for session ${sessionId}`);
    }
    
    // Remove session from database
    await req.whatsappService.deleteSessionFromDB(sessionId);
    
    // Clear session files
    const path = require('path');
    const fs = require('fs');
    const sessionPath = path.join(__dirname, '../auth_sessions', sessionId);
    
    if (fs.existsSync(sessionPath)) {
      console.log(`🗑️ Removing session files at: ${sessionPath}`);
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`✅ Session files removed for ${sessionId}`);
    }
    
    console.log(`✅ Session ${sessionId} destroyed successfully`);
    res.json({ success: true, message: 'Session destroyed successfully' });
    
  } catch (error) {
    console.error('❌ Error destroying session:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add paginated endpoints
router.get('/whatsapp-contacts-paginated/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const page = parseInt(req.query.page) || 0;
    const pageSize = parseInt(req.query.pageSize) || 50;
    
    const result = await req.whatsappService.getWhatsAppContactsPaginated(sessionId, page, pageSize);
    res.json(result);
    
  } catch (error) {
    console.error('Get paginated contacts error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp-groups-paginated/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const page = parseInt(req.query.page) || 0;
    const pageSize = parseInt(req.query.pageSize) || 20;
    
    const result = await req.whatsappService.getWhatsAppGroupsPaginated(sessionId, page, pageSize);
    res.json(result);
    
  } catch (error) {
    console.error('Get paginated groups error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add search endpoint
router.get('/whatsapp-contacts-search/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const search = req.query.search || '';
    const limit = parseInt(req.query.limit) || 100;
    
    const result = await req.whatsappService.searchWhatsAppContacts(sessionId, search, limit);
    res.json(result);
    
  } catch (error) {
    console.error('Search contacts error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;