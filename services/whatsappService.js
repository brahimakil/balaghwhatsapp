const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getDb } = require('../config/firebase');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
  constructor(io) {
    this.io = io;
    this.clients = new Map(); // Store multiple WhatsApp sessions
    this.db = getDb();
    
    // Create auth directory if it doesn't exist
    this.authDir = path.join(__dirname, '../auth_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  // Helper method to format and validate phone numbers
  formatPhoneNumber(phoneNumber) {
    // Remove all non-digit characters
    let cleaned = phoneNumber.replace(/\D/g, '');
    
    // Ensure it starts with country code
    if (cleaned.startsWith('00')) {
      cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('0') && cleaned.length > 10) {
      // Handle cases like 096170049615 -> 96170049615
      cleaned = cleaned.substring(1);
    }
    
    // Validate minimum length (should be at least 10 digits)
    if (cleaned.length < 10) {
      throw new Error(`Invalid phone number: ${phoneNumber}. Must be at least 10 digits.`);
    }
    
    // Validate maximum length (international numbers shouldn't exceed 15 digits)
    if (cleaned.length > 15) {
      throw new Error(`Invalid phone number: ${phoneNumber}. Too long.`);
    }
    
    return cleaned;
  }

  // Helper method to validate message content
  validateMessage(message) {
    if (!message || typeof message !== 'string') {
      throw new Error('Message must be a non-empty string');
    }
    
    // Trim whitespace
    const trimmed = message.trim();
    
    if (trimmed.length === 0) {
      throw new Error('Message cannot be empty');
    }
    
    if (trimmed.length > 4096) {
      throw new Error('Message too long. Maximum 4096 characters allowed.');
    }
    
    return trimmed;
  }

  async createSession(sessionId, adminEmail, restoreSession = true) {
    try {
      console.log(`📱 Creating WhatsApp session: ${sessionId} (restore: ${restoreSession})`);
      
      // Check if session already exists and is connected
      const existingClient = this.clients.get(sessionId);
      if (existingClient) {
        console.log(`✅ Session ${sessionId} already exists and is active`);
        return { success: true, sessionId, alreadyConnected: true };
      }

      // Check if we have a saved session in Firebase
      let sessionDoc = null;
      if (restoreSession) {
        const sessionRef = await this.db.collection('whatsappSessions').doc(sessionId).get();
        if (sessionRef.exists) {
          sessionDoc = sessionRef.data();
          console.log(`🔄 Found existing session in Firebase: ${sessionId}`);
        }
      }

      const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

      const client = new Client({
        authStrategy: new LocalAuth({ 
          clientId: sessionId,
          dataPath: this.authDir
        }),
        puppeteer: {
          headless: true,
          executablePath: resolveChromeExecutable(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
          ]
        }
      });

      // Store client reference
      this.clients.set(sessionId, client);
      console.log(`🗂️ Client stored with sessionId: ${sessionId}. Active clients: ${this.clients.size}`);

      // Set up event handlers
      client.on('qr', async (qr) => {
        console.log(`📋 QR Code generated for session: ${sessionId}`);
        
        try {
          const qrCodeData = await qrcode.toDataURL(qr);
          
          // Save QR code temporarily to Firebase (with expiration)
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            sessionId,
            adminEmail,
            status: 'waiting_for_scan',
            qrCode: qrCodeData,
            qrExpiration: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          // Emit QR code to the specific admin
          this.io.emit('qr-code', { sessionId, qrCode: qrCodeData });
          
        } catch (error) {
          console.error('Error processing QR code:', error);
        }
      });

      client.on('ready', async () => {
        console.log(`✅ WhatsApp client ready for session: ${sessionId}`);
        
        try {
          const info = client.info;
          console.log('📱 WhatsApp client info:', {
            displayName: info.pushname,
            platform: info.platform,
            phone: info.wid.user
          });

          // Ensure client is still in the map (important!)
          this.clients.set(sessionId, client);
          console.log(`🔄 Client re-stored after ready. Active clients: ${this.clients.size}`);

          // Save session info to Firebase
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            sessionId,
            adminEmail,
            status: 'connected',
            phoneNumber: info.wid.user,
            clientName: info.pushname || 'Unknown',
            qrCode: admin.firestore.FieldValue.delete(), // Remove QR code once connected
            connectedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          // Emit ready event to admin
          this.io.emit('client-ready', {
            sessionId,
            phoneNumber: info.wid.user,
            clientName: info.pushname || 'Unknown'
          });

        } catch (error) {
          console.error('Error in ready handler:', error);
        }
      });

      client.on('authenticated', () => {
        console.log(`🔐 WhatsApp authenticated for session: ${sessionId}`);
        // Ensure client is in the map after authentication
        this.clients.set(sessionId, client);
      });

      client.on('auth_failure', async (msg) => {
        console.error(`❌ WhatsApp auth failure for session ${sessionId}:`, msg);
        
        try {
          // Update status in Firebase
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            status: 'auth_failed',
            lastError: msg,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          // Clean up client
          this.clients.delete(sessionId);

          // Emit auth failure event
          this.io.emit('auth-failure', { sessionId, reason: msg });
          
        } catch (error) {
          console.error('Error handling auth failure:', error);
        }
      });

      client.on('disconnected', async (reason) => {
        console.log(`📱 WhatsApp disconnected for session ${sessionId}:`, reason);
        
        try {
          // Update status in Firebase
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            status: 'disconnected',
            lastDisconnectReason: reason,
            disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          // Clean up client
          this.clients.delete(sessionId);

          // Emit disconnection event
          this.io.emit('client-disconnected', { sessionId, reason });
          
        } catch (error) {
          console.error('Error handling disconnection:', error);
        }
      });

      // Initialize the client
      console.log(`🚀 Initializing WhatsApp client for session: ${sessionId}`);
      await client.initialize();

      return { success: true, sessionId };

    } catch (error) {
      console.error(`❌ Error creating WhatsApp session ${sessionId}:`, error);
      
      // Clean up on error
      this.clients.delete(sessionId);
      
      throw error;
    }
  }

  async sendMessage(sessionId, phoneNumber, message) {
    try {
      console.log(`🔍 Looking for client with sessionId: ${sessionId}`);
      console.log(`📋 Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error(`WhatsApp session not found or not connected. Available: [${Array.from(this.clients.keys()).join(', ')}]`);
      }

      // Format and validate phone number
      const formattedPhone = this.formatPhoneNumber(phoneNumber);
      
      // Validate message content
      const validatedMessage = this.validateMessage(message);
      
      // Create WhatsApp chat ID
      const chatId = `${formattedPhone}@c.us`;
      
      console.log(`📤 Sending message to ${chatId}: "${validatedMessage.substring(0, 50)}..."`);
      
      // Check if the number is registered on WhatsApp
      const isRegistered = await client.isRegisteredUser(chatId);
      if (!isRegistered) {
        throw new Error(`Phone number ${phoneNumber} is not registered on WhatsApp`);
      }
      
      // Send the message
      const result = await client.sendMessage(chatId, validatedMessage);

      // Log to Firebase
      await this.db.collection('whatsappMessages').add({
        sessionId,
        chatId,
        originalPhoneNumber: phoneNumber,
        formattedPhoneNumber: formattedPhone,
        message: validatedMessage,
        messageId: result.id.id,
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Message sent successfully to ${formattedPhone}`);
      return { success: true, messageId: result.id.id, formattedPhone };
      
    } catch (error) {
      console.error(`❌ Error sending message to ${phoneNumber}:`, error.message);
      
      // Log failed message to Firebase
      try {
        await this.db.collection('whatsappMessages').add({
          sessionId,
          originalPhoneNumber: phoneNumber,
          message: message.substring(0, 500), // Limit message length in logs
          status: 'failed',
          error: error.message,
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logError) {
        console.error('Error logging failed message:', logError);
      }
      
      throw error;
    }
  }

  async sendBulkMessages(sessionId, phoneNumbers, message, adminEmail) {
    try {
      console.log(`🔍 Bulk send - Looking for client with sessionId: ${sessionId}`);
      console.log(`📋 Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        // Try to find any connected client as fallback
        const connectedClients = Array.from(this.clients.entries()).filter(([id, client]) => client);
        if (connectedClients.length > 0) {
          const [fallbackSessionId, fallbackClient] = connectedClients[0];
          console.log(`🔄 Using fallback session: ${fallbackSessionId}`);
          sessionId = fallbackSessionId; // Update sessionId to use the working one
        } else {
          throw new Error(`WhatsApp session not found or not connected. Requested: ${sessionId}, Available: [${Array.from(this.clients.keys()).join(', ')}]`);
        }
      }

      console.log(`📤 Starting bulk message send to ${phoneNumbers.length} numbers using session: ${sessionId}`);
      const results = [];
      
      // Validate message once
      const validatedMessage = this.validateMessage(message);
      
      for (let i = 0; i < phoneNumbers.length; i++) {
        const phoneNumber = phoneNumbers[i];
        
        try {
          // Add delay to avoid spam detection (2-3 seconds between messages)
          if (i > 0) {
            const delay = 2000 + Math.random() * 1000; // 2-3 seconds
            console.log(`⏳ Waiting ${Math.round(delay)}ms before next message...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          const result = await this.sendMessage(sessionId, phoneNumber, validatedMessage);
          results.push({ 
            phoneNumber, 
            formattedPhone: result.formattedPhone,
            success: true, 
            messageId: result.messageId 
          });
          
          console.log(`✅ ${i + 1}/${phoneNumbers.length} - Success: ${result.formattedPhone}`);
          
          // Emit progress
          this.io.emit('bulk-message-progress', {
            sessionId,
            current: i + 1,
            total: phoneNumbers.length,
            phoneNumber: result.formattedPhone
          });
          
        } catch (error) {
          console.error(`❌ ${i + 1}/${phoneNumbers.length} - Failed: ${phoneNumber} - ${error.message}`);
          results.push({ 
            phoneNumber, 
            success: false, 
            error: error.message 
          });
        }
      }

      // Log bulk operation to Firebase
      await this.db.collection('whatsappBulkOperations').add({
        sessionId,
        adminEmail,
        operation: 'bulk_message',
        totalNumbers: phoneNumbers.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        message: validatedMessage.substring(0, 500), // Limit message length
        results: results.map(r => ({
          phoneNumber: r.phoneNumber,
          success: r.success,
          error: r.error || null
        })),
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const successCount = results.filter(r => r.success).length;
      console.log(`📊 Bulk message operation completed: ${successCount}/${phoneNumbers.length} successful`);

      return { 
        success: true, 
        results,
        totalSent: successCount,
        totalFailed: results.length - successCount
      };
      
    } catch (error) {
      console.error('❌ Error in bulk message operation:', error);
      throw error;
    }
  }

  async createGroup(sessionId, groupName, phoneNumbers, adminEmail) {
    try {
      console.log(`🔍 Group creation - Looking for client with sessionId: ${sessionId}`);
      console.log(`📋 Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error(`WhatsApp session not found or not connected. Available: [${Array.from(this.clients.keys()).join(', ')}]`);
      }

      // Validate group name
      if (!groupName || groupName.trim().length === 0) {
        throw new Error('Group name cannot be empty');
      }

      if (groupName.length > 100) {
        throw new Error('Group name too long. Maximum 100 characters allowed.');
      }

      // Format phone numbers
      const formattedNumbers = [];
      for (const phoneNumber of phoneNumbers) {
        try {
          const formatted = this.formatPhoneNumber(phoneNumber);
          const chatId = `${formatted}@c.us`;
          
          // Check if registered
          const isRegistered = await client.isRegisteredUser(chatId);
          if (isRegistered) {
            formattedNumbers.push(chatId);
          } else {
            console.log(`⚠️ Skipping unregistered number: ${phoneNumber}`);
          }
        } catch (error) {
          console.log(`⚠️ Skipping invalid number: ${phoneNumber} - ${error.message}`);
        }
      }

      if (formattedNumbers.length === 0) {
        throw new Error('No valid WhatsApp numbers found to add to group');
      }

      console.log(`👥 Creating group "${groupName}" with ${formattedNumbers.length} members`);

      // Create group
      const group = await client.createGroup(groupName.trim(), formattedNumbers);

      // Log to Firebase
      await this.db.collection('whatsappGroups').add({
        sessionId,
        adminEmail,
        groupId: group.gid.user,
        groupName: groupName.trim(),
        memberCount: formattedNumbers.length,
        members: formattedNumbers,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Group created successfully: ${group.gid.user}`);

      return { 
        success: true, 
        groupId: group.gid.user,
        groupName: groupName.trim(),
        memberCount: formattedNumbers.length
      };
      
    } catch (error) {
      console.error('❌ Error creating group:', error);
      throw error;
    }
  }

  async restoreAllSessions() {
    try {
      console.log('🔄 Restoring all WhatsApp sessions...');
      
      const sessionsSnapshot = await this.db.collection('whatsappSessions')
        .where('status', '==', 'connected')
        .get();

      if (sessionsSnapshot.empty) {
        console.log('📭 No connected sessions found to restore');
        return;
      }

      const restorePromises = [];
      sessionsSnapshot.forEach(doc => {
        const sessionData = doc.data();
        console.log(`🔄 Restoring session: ${sessionData.sessionId}`);
        
        // Create session without emitting QR (restore mode)
        const restorePromise = this.createSession(
          sessionData.sessionId, 
          sessionData.adminEmail, 
          true
        ).catch(error => {
          console.error(`❌ Failed to restore session ${sessionData.sessionId}:`, error.message);
        });
        
        restorePromises.push(restorePromise);
      });

      await Promise.all(restorePromises);
      console.log(`✅ Session restoration completed. Active sessions: ${this.clients.size}`);
      
    } catch (error) {
      console.error('❌ Error restoring sessions:', error);
    }
  }

  async logoutSession(sessionId) {
    try {
      const client = this.clients.get(sessionId);
      if (client) {
        await client.logout();
        this.clients.delete(sessionId);
      }

      // Clear session from Firebase
      await this.db.collection('whatsappSessions').doc(sessionId).delete();

      // Clear local auth data
      const authPath = path.join(this.authDir, `session-${sessionId}`);
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
      }

      console.log(`🚪 Session ${sessionId} logged out and cleaned up`);
      return { success: true };
      
    } catch (error) {
      console.error(`Error logging out session ${sessionId}:`, error);
      throw error;
    }
  }

  async getSessionStatus(sessionId) {
    try {
      const client = this.clients.get(sessionId);
      const isActive = client ? true : false;
      
      // Get from Firebase
      const sessionDoc = await this.db.collection('whatsappSessions').doc(sessionId).get();
      const sessionData = sessionDoc.exists ? sessionDoc.data() : null;
      
      return {
        sessionId,
        isActive,
        clientConnected: client ? await client.getState() : 'DISCONNECTED',
        firebaseData: sessionData
      };
      
    } catch (error) {
      console.error(`Error getting session status ${sessionId}:`, error);
      return {
        sessionId,
        isActive: false,
        error: error.message
      };
    }
  }

  async disconnectSession(sessionId) {
    try {
      const client = this.clients.get(sessionId);
      if (client) {
        await client.destroy();
        this.clients.delete(sessionId);
      }

      // Update status in Firebase
      await this.db.collection('whatsappSessions').doc(sessionId).set({
        status: 'disconnected',
        disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`🔌 Session ${sessionId} disconnected`);
      return { success: true };
      
    } catch (error) {
      console.error(`Error disconnecting session ${sessionId}:`, error);
      throw error;
    }
  }

  async getSessions() {
    try {
      // Get all sessions from Firebase
      const sessionsSnapshot = await this.db.collection('whatsappSessions').get();
      
      const sessions = [];
      sessionsSnapshot.forEach(doc => {
        const sessionData = doc.data();
        
        // Check if this session has an active client
        const hasActiveClient = this.clients.has(sessionData.sessionId);
        const actualStatus = hasActiveClient ? 'connected' : (sessionData.status || 'disconnected');
        
        sessions.push({
          id: doc.id,
          sessionId: sessionData.sessionId,
          adminEmail: sessionData.adminEmail,
          status: actualStatus, // Use real-time status
          phoneNumber: sessionData.phoneNumber || null,
          clientName: sessionData.clientName || null,
          qrCode: sessionData.qrCode || null,
          createdAt: sessionData.createdAt || null,
          updatedAt: sessionData.updatedAt || null,
          connectedAt: sessionData.connectedAt || null,
          disconnectedAt: sessionData.disconnectedAt || null
        });
      });

      // Sort by creation date (newest first)
      sessions.sort((a, b) => {
        const aTime = a.createdAt?.toDate?.() || new Date(0);
        const bTime = b.createdAt?.toDate?.() || new Date(0);
        return bTime.getTime() - aTime.getTime();
      });

      console.log(`📋 Retrieved ${sessions.length} WhatsApp sessions. Active clients: ${this.clients.size}`);
      return sessions;
      
    } catch (error) {
      console.error('❌ Error getting sessions:', error);
      return []; // Return empty array instead of throwing error
    }
  }

  getAllSessions() {
    const activeSessions = [];
    this.clients.forEach((client, sessionId) => {
      activeSessions.push({
        sessionId,
        isConnected: client ? true : false
      });
    });
    return activeSessions;
  }

  async getGroups() {
    try {
      // Get all groups from Firebase
      const groupsSnapshot = await this.db.collection('whatsappGroups').get();
      
      const groups = [];
      groupsSnapshot.forEach(doc => {
        const groupData = doc.data();
        groups.push({
          id: doc.id,
          groupId: groupData.groupId,
          groupName: groupData.groupName,
          memberCount: groupData.memberCount || 0,
          members: groupData.members || [],
          sessionId: groupData.sessionId,
          adminEmail: groupData.adminEmail,
          createdAt: groupData.createdAt || null
        });
      });

      // Sort by creation date (newest first)
      groups.sort((a, b) => {
        const aTime = a.createdAt?.toDate?.() || new Date(0);
        const bTime = b.createdAt?.toDate?.() || new Date(0);
        return bTime.getTime() - aTime.getTime();
      });

      console.log(`👥 Retrieved ${groups.length} WhatsApp groups`);
      return groups;
      
    } catch (error) {
      console.error('❌ Error getting groups:', error);
      return []; // Return empty array instead of throwing error
    }
  }

  async sendGroupMessage(sessionId, groupId, message, adminEmail) {
    try {
      console.log(`🔍 Group message - Looking for client with sessionId: ${sessionId}`);
      console.log(`📋 Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      
      const client = this.clients.get(sessionId);
      if (!client) {
        // Try to find any connected client as fallback
        const connectedClients = Array.from(this.clients.entries()).filter(([id, client]) => client);
        if (connectedClients.length > 0) {
          const [fallbackSessionId, fallbackClient] = connectedClients[0];
          console.log(`🔄 Using fallback session: ${fallbackSessionId}`);
          sessionId = fallbackSessionId; // Update sessionId to use the working one
        } else {
          throw new Error(`WhatsApp session not found or not connected. Requested: ${sessionId}, Available: [${Array.from(this.clients.keys()).join(', ')}]`);
        }
      }

      // Validate message content
      const validatedMessage = this.validateMessage(message);
      
      // Create WhatsApp group chat ID
      const groupChatId = `${groupId}@g.us`;
      
      console.log(`👥 Sending group message to ${groupChatId}: "${validatedMessage.substring(0, 50)}..."`);
      
      // Send the message to the group
      const result = await client.sendMessage(groupChatId, validatedMessage);

      // Log to Firebase
      await this.db.collection('whatsappMessages').add({
        sessionId,
        chatId: groupChatId,
        groupId,
        message: validatedMessage,
        messageId: result.id.id,
        status: 'sent',
        type: 'group',
        sentBy: adminEmail,
        sentAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Group message sent successfully to ${groupId}`);
      return { success: true, messageId: result.id.id, groupId };
      
    } catch (error) {
      console.error(`❌ Error sending group message to ${groupId}:`, error.message);
      
      // Log failed message to Firebase
      try {
        await this.db.collection('whatsappMessages').add({
          sessionId,
          groupId,
          message: message.substring(0, 500), // Limit message length in logs
          status: 'failed',
          type: 'group',
          error: error.message,
          sentBy: adminEmail,
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logError) {
        console.error('Error logging failed group message:', logError);
      }
      
      throw error;
    }
  }
}

module.exports = WhatsAppService;