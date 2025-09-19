const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getDb } = require('../config/firebase');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function resolveChromeExecutable() {
  const envPath = process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    envPath,
    '/usr/bin/chromium',               // apt chromium (works on Railway)
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome'
    // DO NOT use '/usr/bin/chromium-browser' → snap wrapper
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return undefined; // fall back to puppeteer’s bundled if present
}


class WhatsAppService {
  constructor(io) {
    this.io = io;
    this.clients = new Map(); // Store multiple WhatsApp sessions
    this.db = getDb();
    
    // Add session health monitoring
    this.healthCheckInterval = null;
    this.sessionHealthStatus = new Map(); // Track health of each session
    this.maxFailedChecks = 3; // Number of failed checks before restart
    this.healthCheckIntervalMs = 5 * 60 * 1000; // Check every 5 minutes
    
    // Create auth directory if it doesn't exist
    this.authDir = path.join(__dirname, '../auth_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    
    // Start automatic health monitoring
    this.startHealthMonitoring();
    this.healthCache = new Map(); // Add this
    this.lastHealthCheck = new Map(); // Add this
  }

  // Add health monitoring methods
  startHealthMonitoring() {
    console.log('🏥 Starting session health monitoring...');
    
    this.healthCheckInterval = setInterval(async () => {
      await this.checkAllSessionsHealth();
    }, this.healthCheckIntervalMs);
    
    // Add client restart interval to prevent memory leaks
    this.clientRestartInterval = setInterval(async () => {
      await this.restartOldClients();
    }, 2 * 60 * 60 * 1000); // Every 2 hours
    
    console.log(`🏥 Health monitoring started (${this.healthCheckIntervalMs / 60000} minute intervals)`);
  }

  async checkAllSessionsHealth() {
    console.log('🔍 Performing health check on all sessions...');
    
    for (const [sessionId, client] of this.clients.entries()) {
      try {
        await this.checkSessionHealth(sessionId, client);
      } catch (error) {
        console.error(`❌ Health check failed for session ${sessionId}:`, error.message);
      }
    }
  }

  async checkSessionHealth(sessionId, client) {
    try {
      console.log(`🔍 Health check for session: ${sessionId}`);
      
      // Try to get the client state
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 10000))
      ]);
      
      if (state === 'CONNECTED') {
        // Session is healthy
        this.sessionHealthStatus.set(sessionId, { healthy: true, failedChecks: 0, lastCheck: Date.now() });
        console.log(`✅ Session ${sessionId} is healthy`);
        
        // Update session in database
        await this.updateSessionInDB(sessionId, 'connected');
        
      } else {
        // Session is not connected
        console.log(`⚠️ Session ${sessionId} state: ${state}`);
        await this.handleUnhealthySession(sessionId, `Disconnected state: ${state}`);
      }
      
    } catch (error) {
      console.error(`❌ Health check error for session ${sessionId}:`, error.message);
      await this.handleUnhealthySession(sessionId, error.message);
    }
  }

  async handleUnhealthySession(sessionId, reason) {
    const healthStatus = this.sessionHealthStatus.get(sessionId) || { healthy: false, failedChecks: 0 };
    healthStatus.failedChecks += 1;
    healthStatus.healthy = false;
    healthStatus.lastCheck = Date.now();
    healthStatus.lastError = reason;
    
    this.sessionHealthStatus.set(sessionId, healthStatus);
    
    console.log(`🚨 Session ${sessionId} unhealthy (${healthStatus.failedChecks}/${this.maxFailedChecks}): ${reason}`);
    
    if (healthStatus.failedChecks >= this.maxFailedChecks) {
      console.log(`💀 Session ${sessionId} failed ${this.maxFailedChecks} health checks. Initiating automatic recovery...`);
      await this.recoverSession(sessionId);
    }
  }

  async recoverSession(sessionId) {
    try {
      console.log(`🔄 Starting automatic recovery for session: ${sessionId}`);
      
      // Remove the failed client
      const oldClient = this.clients.get(sessionId);
      if (oldClient) {
        try {
          await oldClient.destroy();
        } catch (e) {
          console.log('Failed to destroy old client (expected):', e.message);
        }
        this.clients.delete(sessionId);
      }
      
      // Update database status
      await this.updateSessionInDB(sessionId, 'recovering');
      
      // Emit recovery status to frontend
      this.io.emit('session_recovery', { sessionId, status: 'recovering' });
      
      // Wait a bit before recreating
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Recreate the session
      console.log(`🔄 Recreating WhatsApp session: ${sessionId}`);
      await this.createSession(sessionId, true); // true = restore from existing auth
      
      // Reset health status
      this.sessionHealthStatus.set(sessionId, { healthy: true, failedChecks: 0, lastCheck: Date.now() });
      
      console.log(`✅ Session ${sessionId} recovered successfully`);
      this.io.emit('session_recovery', { sessionId, status: 'recovered' });
      
    } catch (error) {
      console.error(`❌ Failed to recover session ${sessionId}:`, error);
      
      // Mark as failed in database
      await this.updateSessionInDB(sessionId, 'failed');
      this.io.emit('session_recovery', { sessionId, status: 'failed', error: error.message });
      
      // Remove from health monitoring
      this.sessionHealthStatus.delete(sessionId);
    }
  }

  // Add graceful shutdown
  async shutdown() {
    console.log('🛑 Shutting down WhatsApp service...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log('🏥 Health monitoring stopped');
    }
    
    // Close all clients
    for (const [sessionId, client] of this.clients.entries()) {
      try {
        console.log(`🛑 Closing session: ${sessionId}`);
        await client.destroy();
      } catch (error) {
        console.log(`Failed to close session ${sessionId}:`, error.message);
      }
    }
    
    this.clients.clear();
    console.log('✅ WhatsApp service shutdown complete');
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

  // Enhanced session health check
  async checkSessionHealth(sessionId) {
    try {
      // Cache health results for 15 seconds
      const cached = this.healthCache.get(sessionId);
      const lastCheck = this.lastHealthCheck.get(sessionId) || 0;
      
      if (cached && (Date.now() - lastCheck) < 15000) {
        console.log(`🔄 Using cached health for ${sessionId}: ${cached.reason}`);
        return cached;
      }

      const client = this.clients.get(sessionId);
      if (!client) {
        const result = { healthy: false, reason: 'Client not found in memory' };
        this.healthCache.set(sessionId, result);
        this.lastHealthCheck.set(sessionId, Date.now());
        return result;
      }

      // Try to get state with timeout
      const statePromise = client.getState();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('State check timeout')), 2000) // Reduced timeout
      );
      
      const state = await Promise.race([statePromise, timeoutPromise]);
      
      // Only consider CONNECTED as healthy for chat operations
      let result;
      if (state === 'CONNECTED') {
        result = { healthy: true, reason: 'Connected and responsive' };
      } else {
        result = { healthy: false, reason: `Client state: ${state}` };
      }

      // Cache the result
      this.healthCache.set(sessionId, result);
      this.lastHealthCheck.set(sessionId, Date.now());
      
      return result;
    } catch (error) {
      const result = { healthy: false, reason: error.message };
      this.healthCache.set(sessionId, result);
      this.lastHealthCheck.set(sessionId, Date.now());
      return result;
    }
  }

  // Enhanced createSession with better error handling
  async createSession(sessionId, adminEmail, restoreSession = true) {
    try {
      console.log(`📱 Creating WhatsApp session: ${sessionId} (restore: ${restoreSession})`);
      console.log(`🔍 Current active clients: ${this.clients.size}`);
      console.log(`🔍 Client exists for ${sessionId}: ${this.clients.has(sessionId)}`);
      
      // Check existing session in database first
      const existingSession = await this.getSessionFromDB(sessionId);
      if (existingSession && existingSession.status === 'connected') {
        console.log(`🔄 Found connected session in DB, attempting to restore...`);
      }

      // Check if session already exists and is healthy
      const existingClient = this.clients.get(sessionId);
      if (existingClient) {
        console.log(`⚠️ Found existing client for ${sessionId}, checking health...`);
        const health = await this.checkSessionHealth(sessionId);
        console.log(`🔍 Health check result for ${sessionId}:`, health);
        
        if (health.healthy) {
          // Check if it's actually connected, not just healthy
          try {
            const state = await existingClient.getState();
            console.log(`🔍 Current state for ${sessionId}: ${state}`);
            
            if (state === 'CONNECTED') {
              console.log(`✅ Session ${sessionId} already exists and is connected`);
              return { success: true, sessionId, alreadyConnected: true };
            } else {
              console.log(`🔧 Session ${sessionId} exists but not connected (${state}), will recreate...`);
              // Destroy and remove the existing client
              try {
                await existingClient.destroy();
              } catch (destroyError) {
                console.error(`❌ Error destroying existing client:`, destroyError);
              }
              this.clients.delete(sessionId);
              console.log(`🗑️ Removed existing unhealthy client for ${sessionId}`);
            }
          } catch (stateError) {
            console.log(`🔧 Could not get state for ${sessionId}, recreating...`, stateError.message);
            this.clients.delete(sessionId);
          }
        } else {
          console.log(`🔧 Existing session ${sessionId} is unhealthy, recreating...`);
          this.clients.delete(sessionId);
        }
      }

      // Create a completely new client
      console.log(`🆕 Creating new client for session: ${sessionId}`);
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId, dataPath: this.authDir }),
        puppeteer: {
          headless: true,
          executablePath: resolveChromeExecutable(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--no-first-run',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=VizDisplayCompositor',
            '--disable-ipc-flooding-protection',
            '--disable-web-security',
            '--disable-features=site-per-process',
            '--memory-pressure-off',           // Add this
            '--max_old_space_size=2048',       // Add this  
            '--optimize-for-size'             // Add this
          ]
        }
      });

      // Store client reference immediately
      this.clients.set(sessionId, client);
      console.log(`🗂️ Client stored with sessionId: ${sessionId}. Active clients: ${this.clients.size}`);

      // Set initial status to waiting_for_scan in database
      await this.updateSessionInDB(sessionId, 'waiting_for_scan', {
        adminEmail,
        createdAt: new Date().toISOString()
      });
      console.log(`📝 Initial session status set to 'waiting_for_scan' for ${sessionId}`);

      // Enhanced event handlers
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

          console.log(`📋 QR Code data length: ${qrCodeData?.length}`);
          console.log(`📋 Emitting QR code to Socket.IO...`);

          // Emit QR code to all connected clients
          this.io.emit('qr-code', { sessionId, qrCode: qrCodeData });

          console.log(`📋 QR code emitted for session: ${sessionId}`);
          
        } catch (error) {
          console.error('Error processing QR code:', error);
        }
      });

      // Enhanced ready event handler with phone number change detection
      client.on('ready', async () => {
        console.log(`✅ WhatsApp client ready for session: ${sessionId}`);
        
        try {
          const info = client.info;
          const currentPhoneNumber = info.wid.user;
          
          console.log('📱 WhatsApp client info:', {
            displayName: info.pushname,
            platform: info.platform,
            phone: currentPhoneNumber
          });

          // 🔍 CHECK FOR PHONE NUMBER CHANGE
          const existingSession = await this.getSessionFromDB(sessionId);
          if (existingSession && existingSession.phoneNumber && existingSession.phoneNumber !== currentPhoneNumber) {
            console.log(`🔄 PHONE NUMBER CHANGED DETECTED!`);
            console.log(`📱 Old phone: ${existingSession.phoneNumber}`);
            console.log(`📱 New phone: ${currentPhoneNumber}`);
            
            // 🗑️ CLEAR ALL CACHED DATA
            await this.clearCachedDataForPhoneChange(sessionId, existingSession.phoneNumber, currentPhoneNumber);
          }

          // Ensure client is still in the map
          this.clients.set(sessionId, client);

          // 💾 Save session info to Firebase WITH PHONE NUMBER
          await this.updateSessionInDB(sessionId, 'connected', {
            phoneNumber: currentPhoneNumber,
            displayName: info.pushname,
            platform: info.platform,
            lastConnected: new Date().toISOString()
          });

          console.log(`✅ Session ${sessionId} saved with phone: ${currentPhoneNumber}`);
          
          // 🔄 Emit session ready event
          this.io.emit('session_ready', { 
            sessionId, 
            phoneNumber: currentPhoneNumber,
            displayName: info.pushname 
          });

        } catch (error) {
          console.error(`❌ Error in ready handler for ${sessionId}:`, error);
        }
      });

      client.on('chats-received', async () => {
        console.log('✅ All chats received for session:', sessionId);
        
        try {
          // Now it's safe to get chats
          const chats = await client.getChats();
          console.log(`📊 Successfully loaded ${chats.length} chats`);
          
          const groups = chats.filter(chat => chat.isGroup);
          const contacts = chats.filter(chat => !chat.isGroup);
          
          console.log(`👥 Groups: ${groups.length}`);
          console.log(`👤 Contacts: ${contacts.length}`);
          
          // Emit sync complete
          this.io.emit('sync_status', { 
            sessionId,
            isSyncing: false, 
            message: `Sync complete! Found ${chats.length} chats (${groups.length} groups, ${contacts.length} contacts)` 
          });
          this.io.emit('sync_complete', { sessionId });
          
        } catch (error) {
          console.error('❌ Error in chats-received:', error);
          this.io.emit('sync_status', { 
            sessionId,
            isSyncing: false, 
            message: 'Sync completed with errors - contacts may be partially loaded' 
          });
        }
      });

      client.on('authenticated', () => {
        console.log(`🔐 WhatsApp authenticated for session: ${sessionId}`);
        this.clients.set(sessionId, client);
      });

      client.on('auth_failure', async (msg) => {
        console.error(`❌ WhatsApp auth failure for session ${sessionId}:`, msg);
        
        try {
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            status: 'auth_failed',
            lastError: msg,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          this.clients.delete(sessionId);
          this.io.emit('auth-failure', { sessionId, reason: msg });
          
        } catch (error) {
          console.error('Error handling auth failure:', error);
        }
      });

      client.on('disconnected', async (reason) => {
        console.log(`📱 WhatsApp disconnected for session ${sessionId}:`, reason);
        
        try {
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            status: 'disconnected',
            lastDisconnectReason: reason,
            disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          this.clients.delete(sessionId);
          this.io.emit('client-disconnected', { sessionId, reason });
          
          // Attempt auto-reconnection after disconnect
          if (reason !== 'LOGOUT') {
            setTimeout(() => this.attemptAutoReconnect(sessionId), 10000);
          }
          
        } catch (error) {
          console.error('Error handling disconnection:', error);
        }
      });

      // Add error handler for Puppeteer crashes
      client.on('error', async (error) => {
        console.error(`🚨 Client error for session ${sessionId}:`, error.message);
        
        if (error.message.includes('Session closed') || error.message.includes('Protocol error')) {
          await this.handleUnhealthySession(sessionId, error.message);
        }
      });

      // Initialize with timeout
      console.log(`🚀 Initializing WhatsApp client for session: ${sessionId}`);
      
      const initPromise = client.initialize();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Client initialization timeout')), 60000)
      );
      
      await Promise.race([initPromise, timeoutPromise]);
      
      return { success: true, sessionId };

    } catch (error) {
      console.error(`❌ Error creating WhatsApp session ${sessionId}:`, error);
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
      
      // Process each session with proper async handling
      for (const doc of sessionsSnapshot.docs) {
        const sessionData = doc.data();
        
        // Check if this session has an active client and its actual state
        const client = this.clients.get(sessionData.sessionId);
        let actualStatus = sessionData.status || 'disconnected';
        
        if (client) {
          try {
            // Synchronously get the real client state
            const state = await client.getState();
            console.log(`🔍 Client state for ${sessionData.sessionId}: ${state}`);
            
            // Only mark as connected if truly CONNECTED
            if (state === 'CONNECTED') {
              actualStatus = 'connected';
            } else {
              // Trust database status for other states (waiting_for_scan, etc.)
              actualStatus = sessionData.status || 'disconnected';
            }
          } catch (error) {
            console.log(`⚠️ Could not get state for ${sessionData.sessionId}, using database status`);
            // If error getting state, trust the database status
            actualStatus = sessionData.status || 'disconnected';
          }
        } else {
          // No client in memory, definitely disconnected
          actualStatus = 'disconnected';
        }
        
        sessions.push({
          id: doc.id,
          sessionId: sessionData.sessionId,
          adminEmail: sessionData.adminEmail,
          status: actualStatus,
          phoneNumber: sessionData.phoneNumber || null,
          clientName: sessionData.clientName || null,
          qrCode: sessionData.qrCode || null,
          createdAt: sessionData.createdAt,
          updatedAt: sessionData.updatedAt
        });
      }
      
      console.log(`📋 Retrieved ${sessions.length} WhatsApp sessions. Active clients: ${this.clients.size}`);
      return sessions;
      
    } catch (error) {
      console.error('❌ Error getting sessions:', error);
      return [];
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

  // Get chats directly from WhatsApp (replaces manual contact management)
  async getChats(sessionId) {
    console.log('\n🔗 getChats called for session:', sessionId);
    try {
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not ready');
      }

      // Use getChats() to get all chats
      const chats = await client.getChats();
      console.log(`📊 Retrieved ${chats.length} chats`);
      
      const chatData = await Promise.all(
        chats.map(async (chat, index) => {
          try {
            const contact = await chat.getContact();
            const chatInfo = {
              id: chat.id._serialized,
              name: chat.name || contact.pushname || contact.number,
              isGroup: chat.isGroup,
              unreadCount: chat.unreadCount,
              lastMessage: chat.lastMessage ? {
                body: chat.lastMessage.body,
                timestamp: chat.lastMessage.timestamp,
                fromMe: chat.lastMessage.fromMe
              } : null,
              profilePicUrl: contact.profilePicUrl || null
            };
            
            if (index < 3) { // Log first 3 for debugging
              console.log(`  ${index + 1}. ${chat.isGroup ? '👥' : '👤'} ${chatInfo.name}`);
            }
            
            return chatInfo;
          } catch (error) {
            console.error(`❌ Error processing chat ${index + 1}:`, error.message);
            return {
              id: chat.id._serialized,
              name: chat.name || 'Unknown',
              isGroup: chat.isGroup,
              unreadCount: chat.unreadCount || 0,
              lastMessage: null,
              profilePicUrl: null
            };
          }
        })
      );

      console.log(`✅ Successfully processed ${chatData.length} chats`);
      return chatData;
    } catch (error) {
      console.error('❌ Error in getChats:', error.message);
      throw error;
    }
  }

  // Enhanced getWhatsAppContacts with session health check
  async getWhatsAppContacts(sessionId) {
    console.log('\n👤 getWhatsAppContacts called for session:', sessionId);
    
    try {
      // Check session health first
      const health = await this.checkSessionHealth(sessionId);
      if (!health.healthy) {
        console.log(`❌ Session ${sessionId} is not healthy: ${health.reason}`);
        await this.handleUnhealthySession(sessionId, health.reason);
        return [];
      }

      const client = this.clients.get(sessionId);
      const chats = await client.getChats();
      
      const contacts = await Promise.all(
        chats
          .filter(chat => !chat.isGroup)
          .map(async (chat, index) => {
            try {
              const contact = await chat.getContact();
              const contactInfo = {
                id: chat.id._serialized,
                name: contact.pushname || contact.name || contact.number,
                number: contact.number,
                isMyContact: contact.isMyContact,
                unreadCount: chat.unreadCount,
                lastMessage: chat.lastMessage ? {
                  body: chat.lastMessage.body,
                  timestamp: chat.lastMessage.timestamp,
                  fromMe: chat.lastMessage.fromMe
                } : null,
                profilePicUrl: contact.profilePicUrl || null,
                isGroup: false
              };
              
              if (index < 3) { // Log first 3 for debugging
                console.log(`  ${index + 1}. ${contactInfo.name} (${contactInfo.number})`);
              }
              
              return contactInfo;
            } catch (error) {
              console.error(`❌ Error processing contact ${index + 1}:`, error.message);
              return {
                id: chat.id._serialized,
                name: 'Unknown Contact',
                number: 'Unknown',
                isMyContact: false,
                unreadCount: chat.unreadCount || 0,
                lastMessage: null,
                profilePicUrl: null,
                isGroup: false
              };
            }
          })
      );

      console.log(`✅ Successfully processed ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.error('❌ Error in getWhatsAppContacts:', error.message);
      
      if (error.message.includes('Session closed') || error.message.includes('Protocol error')) {
        await this.handleUnhealthySession(sessionId, error.message);
      }
      
      return [];
    }
  }

  // Fix getWhatsAppGroups - keep simple, just handle errors gracefully  
  async getWhatsAppGroups(sessionId) {
    console.log('\n👥 getWhatsAppGroups called for session:', sessionId);
    try {
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not ready');
      }

      const chats = await client.getChats();
      const groups = await Promise.all(
        chats
          .filter(chat => chat.isGroup)
          .map(async (group, index) => {
            try {
              const participants = group.participants || [];
              const groupInfo = {
                id: group.id._serialized,
                name: group.name,
                participantCount: participants.length,
                unreadCount: group.unreadCount,
                lastMessage: group.lastMessage ? {
                  body: group.lastMessage.body,
                  timestamp: group.lastMessage.timestamp,
                  fromMe: group.lastMessage.fromMe
                } : null,
                description: group.description || '',
                owner: group.owner,
                isGroup: true
              };
              
              if (index < 3) { // Log first 3 for debugging
                console.log(`  ${index + 1}. ${groupInfo.name} (${groupInfo.participantCount} participants)`);
              }
              
              return groupInfo;
            } catch (error) {
              console.error(`❌ Error processing group ${index + 1}:`, error.message);
              return {
                id: group.id._serialized,
                name: group.name || 'Unknown Group',
                participantCount: 0,
                unreadCount: group.unreadCount || 0,
                lastMessage: null,
                description: '',
                owner: null,
                isGroup: true
              };
            }
          })
      );

      console.log(`✅ Successfully processed ${groups.length} groups`);
      return groups;
    } catch (error) {
      console.error('❌ Error in getWhatsAppGroups:', error.message);
      return []; // Return empty array instead of throwing error
    }
  }

  // Update the sendBulkMessagesToChats function with better session checking
  async sendBulkMessagesToChats(sessionId, message, selectedChats, delayBetweenMessages = 3, adminEmail) {
    console.log('\n📤 Bulk message request received');
    
    try {
      const client = this.clients.get(sessionId);
      if (!client) {
        throw new Error('WhatsApp client not ready');
      }

      // Check if client is still connected before sending
      try {
        const state = await client.getState();
        console.log(`📱 Client state before sending: ${state}`);
        
        if (state !== 'CONNECTED') {
          throw new Error(`WhatsApp client not connected. Current state: ${state}. Please reconnect.`);
        }
      } catch (stateError) {
        console.error('❌ Error checking client state:', stateError.message);
        
        // If we can't even check state, the session is probably dead
        if (stateError.message.includes('Session closed') || stateError.message.includes('Protocol error')) {
          // Clean up the dead session
          this.clients.delete(sessionId);
          
          // Update status in Firebase
          await this.db.collection('whatsappSessions').doc(sessionId).set({
            status: 'disconnected',
            lastDisconnectReason: 'Session closed unexpectedly',
            disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          
          // Emit disconnection event
          this.io.emit('client-disconnected', { 
            sessionId, 
            reason: 'Session closed unexpectedly - please reconnect' 
          });
          
          throw new Error('WhatsApp session has closed. Please reconnect your WhatsApp.');
        }
        
        throw stateError;
      }

      if (!message || !selectedChats || selectedChats.length === 0) {
        throw new Error('Message and recipients are required');
      }

      console.log(`📋 Sending "${message}" to ${selectedChats.length} chats`);

      const results = {
        successful: [],
        failed: [],
        total: selectedChats.length
      };
      
      for (let i = 0; i < selectedChats.length; i++) {
        const chatId = selectedChats[i];
        try {
          console.log(`📤 Sending to ${i + 1}/${selectedChats.length}: ${chatId}`);
          
          // Check if client is still alive before each message
          const currentState = await client.getState();
          if (currentState !== 'CONNECTED') {
            throw new Error(`Client disconnected during sending. State: ${currentState}`);
          }
          
          const chat = await client.getChatById(chatId);
          await chat.sendMessage(message);
          
          results.successful.push(chatId);
          console.log(`✅ Sent successfully to ${chatId}`);
          
          // Add delay between messages
          if (i < selectedChats.length - 1) {
            console.log(`⏳ Waiting ${delayBetweenMessages} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delayBetweenMessages * 1000));
          }
          
        } catch (error) {
          console.error(`❌ Failed to send to ${chatId}:`, error.message);
          results.failed.push({ chatId, error: error.message });
          
          // If it's a session error, stop trying
          if (error.message.includes('Session closed') || error.message.includes('Protocol error')) {
            console.error('❌ Session died during bulk send, stopping...');
            break;
          }
        }
      }

      console.log(`📊 Bulk send completed: ${results.successful.length} successful, ${results.failed.length} failed`);
      
      return {
        success: true,
        results,
        message: `Sent to ${results.successful.length}/${results.total} recipients`
      };
      
    } catch (error) {
      console.error('❌ Error sending bulk message:', error.message);
      throw error;
    }
  }

  // Cleanup method
  cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      console.log('🏥 Health monitoring stopped');
    }
  }

  // 🗑️ NEW METHOD: Clear cached data when phone number changes
  async clearCachedDataForPhoneChange(sessionId, oldPhone, newPhone) {
    try {
      console.log(`🧹 Clearing cached data for phone change: ${oldPhone} → ${newPhone}`);
      
      // 1. Clear in-memory caches (if any)
      if (this.contactsCache) {
        this.contactsCache.delete(sessionId);
      }
      if (this.groupsCache) {
        this.groupsCache.delete(sessionId);
      }
      if (this.chatsCache) {
        this.chatsCache.delete(sessionId);
      }
      
      // 2. Clear any session-specific temporary data
      console.log(`🗑️ Cleared in-memory caches for session: ${sessionId}`);
      
      // 3. Emit event to frontend to clear cached data
      this.io.emit('phone_number_changed', {
        sessionId,
        oldPhone,
        newPhone,
        action: 'clear_cache'
      });
      
      // 4. Wait a moment for frontend to process
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 5. Force reload contacts and groups with new phone number
      console.log(`🔄 Reloading data for new phone number: ${newPhone}`);
      
      // Emit event that new data should be loaded
      this.io.emit('phone_number_changed', {
        sessionId,
        oldPhone,
        newPhone,
        action: 'reload_data'
      });
      
      console.log(`✅ Cache cleared and reload initiated for new phone: ${newPhone}`);
      
    } catch (error) {
      console.error(`❌ Error clearing cache for phone change:`, error);
    }
  }

  // 🔍 Helper method to get session from database
  async getSessionFromDB(sessionId) {
    try {
      const sessionsRef = admin.firestore().collection('whatsappSessions');
      const sessionDoc = await sessionsRef.doc(sessionId).get();
      
      if (sessionDoc.exists) {
        return { id: sessionDoc.id, ...sessionDoc.data() };
      }
      return null;
    } catch (error) {
      console.error(`Error getting session ${sessionId} from DB:`, error);
      return null;
    }
  }

  // 📝 Enhanced updateSessionInDB method to include additional data
  async updateSessionInDB(sessionId, status, additionalData = {}) {
    try {
      const sessionsRef = admin.firestore().collection('whatsappSessions');
      const sessionData = {
        sessionId,
        status,
        lastUpdated: new Date().toISOString(),
        ...additionalData
      };
      
      await sessionsRef.doc(sessionId).set(sessionData, { merge: true });
      console.log(`💾 Session ${sessionId} updated in DB with status: ${status}`);
      
    } catch (error) {
      console.error(`❌ Error updating session ${sessionId} in DB:`, error);
    }
  }

  // 🗑️ DELETE session completely from database
  async deleteSessionFromDB(sessionId) {
    try {
      console.log(`🗑️ Attempting to delete session ${sessionId} from database`);
      
      // Use Firebase Admin SDK correctly
      await admin.firestore().collection('whatsappSessions').doc(sessionId).delete();
      
      console.log(`🗑️ Session ${sessionId} completely deleted from database`);
      
    } catch (error) {
      console.error(`❌ Error deleting session ${sessionId} from DB:`, error);
      
      // Fallback to marking as destroyed if delete fails
      console.log(`⚠️ Falling back to marking session ${sessionId} as destroyed`);
      await this.updateSessionInDB(sessionId, 'destroyed');
    }
  }

  // Add paginated contacts endpoint
  async getWhatsAppContactsPaginated(sessionId, page = 0, pageSize = 50) {
    try {
      console.log(`👤 getWhatsAppContactsPaginated called for session: ${sessionId}, page: ${page}, pageSize: ${pageSize}`);
      
      const health = await this.checkSessionHealth(sessionId);
      if (!health.healthy) {
        console.log(`⏳ Session ${sessionId} is not ready for chat operations: ${health.reason}`);
        
        if (health.reason.includes('Client state: null') || health.reason.includes('OPENING') || health.reason.includes('PAIRING')) {
          return { contacts: [], totalContacts: 0, hasMore: false, page, pending: true, reason: 'Session initializing...' };
        }
        
        return { contacts: [], totalContacts: 0, hasMore: false, page, error: health.reason };
      }

      const client = this.clients.get(sessionId);
      
      // Get both contacts and chats to cross-reference
      const [contacts, chats] = await Promise.all([
        client.getContacts(),
        client.getChats()
      ]);
      
      // Create a Set of numbers that have actual chat history
      const numbersWithChats = new Set();
      chats.forEach(chat => {
        if (!chat.isGroup && chat.id && chat.id.user) {
          numbersWithChats.add(chat.id.user);
        }
      });
      
      // Filter contacts more strictly
      const validContacts = contacts
        .filter(contact => {
          // Must have valid ID and user number
          if (!contact.id || !contact.id.user || contact.isGroup) {
            return false;
          }
          
          // Only include contacts that:
          // 1. Are saved in phone (isMyContact = true) OR
          // 2. Have actual chat history with you
          const hasName = contact.name || contact.pushname;
          const isRealContact = contact.isMyContact || numbersWithChats.has(contact.id.user);
          
          return hasName && isRealContact;
        })
        // Remove duplicates by both name and phone number
        .reduce((unique, contact) => {
          const phoneNumber = contact.id.user;
          const name = (contact.name || contact.pushname || '').toLowerCase().trim();
          
          // Check for duplicate by phone number OR by name (if name exists)
          const existingByPhone = unique.find(c => c.id.user === phoneNumber);
          const existingByName = name ? unique.find(c => {
            const existingName = (c.name || c.pushname || '').toLowerCase().trim();
            return existingName === name && existingName !== '';
          }) : null;
          
          const existing = existingByPhone || existingByName;
          
          if (!existing) {
            unique.push(contact);
          } else {
            // Keep the better contact (priority: real name > pushname > phone number length)
            const currentScore = this.getContactScore(contact);
            const existingScore = this.getContactScore(existing);
            
            if (currentScore > existingScore) {
              const index = unique.indexOf(existing);
              unique[index] = contact;
            }
          }
          
          return unique;
        }, [])
        // Sort by name
        .sort((a, b) => {
          const nameA = a.name || a.pushname || 'Unknown';
          const nameB = b.name || b.pushname || 'Unknown';
          return nameA.localeCompare(nameB);
        });

      console.log(`📞 Filtered ${validContacts.length} valid contacts from ${contacts.length} total contacts`);

      // Calculate pagination
      const startIndex = page * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedContacts = validContacts.slice(startIndex, endIndex);
      const hasMore = endIndex < validContacts.length;

      // Format contacts
      const formattedContacts = paginatedContacts.map(contact => ({
        id: contact.id._serialized,
        name: contact.name || contact.pushname || 'Unknown',
        number: contact.id.user,
        isGroup: false,
        isMyContact: contact.isMyContact || false,
        profilePicUrl: contact.profilePicUrl || null,
        unreadCount: 0,
        hasChat: numbersWithChats.has(contact.id.user)
      }));

      console.log(`📞 Returning ${formattedContacts.length}/${validContacts.length} contacts (page ${page + 1})`);
      
      return {
        contacts: formattedContacts,
        totalContacts: validContacts.length,
        hasMore,
        page,
        pageSize
      };
    } catch (error) {
      console.error(`❌ Error getting paginated contacts for session ${sessionId}:`, error);
      return { contacts: [], totalContacts: 0, hasMore: false, page, error: error.message };
    }
  }

  // Add paginated groups endpoint  
  async getWhatsAppGroupsPaginated(sessionId, page = 0, pageSize = 20) {
    try {
      console.log(`👥 getWhatsAppGroupsPaginated called for session: ${sessionId}, page: ${page}, pageSize: ${pageSize}`);
      
      const health = await this.checkSessionHealth(sessionId);
      if (!health.healthy) {
        console.log(`⏳ Session ${sessionId} is not ready for chat operations: ${health.reason}`);
        
        // If it's just not connected yet, return a pending state
        if (health.reason.includes('Client state: null') || health.reason.includes('OPENING') || health.reason.includes('PAIRING')) {
          return { groups: [], totalGroups: 0, hasMore: false, page, pending: true, reason: 'Session initializing...' };
        }
        
        return { groups: [], totalGroups: 0, hasMore: false, page, error: health.reason };
      }

      const client = this.clients.get(sessionId);
      const chats = await client.getChats();
      
      // Filter groups and sort
      const validGroups = chats
        .filter(chat => chat.isGroup)
        .sort((a, b) => (a.name || 'Unknown Group').localeCompare(b.name || 'Unknown Group'));

      // Calculate pagination
      const startIndex = page * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedGroups = validGroups.slice(startIndex, endIndex);
      const hasMore = endIndex < validGroups.length;

      // Format groups
      const formattedGroups = paginatedGroups.map(group => ({
        id: group.id._serialized,
        name: group.name || 'Unknown Group',
        isGroup: true,
        participantCount: group.participants ? group.participants.length : 0,
        unreadCount: group.unreadCount || 0,
        description: group.description || null,
        owner: group.owner ? group.owner._serialized : null
      }));

      console.log(`👥 Returning ${formattedGroups.length}/${validGroups.length} groups (page ${page + 1})`);
      
      return {
        groups: formattedGroups,
        totalGroups: validGroups.length,
        hasMore,
        page,
        pageSize
      };
    } catch (error) {
      console.error(`❌ Error getting paginated groups for session ${sessionId}:`, error);
      return { groups: [], totalGroups: 0, hasMore: false, page, error: error.message };
    }
  }

  // Add search method
  async searchWhatsAppContacts(sessionId, searchTerm, limit = 100) {
    try {
      console.log(`�� Searching contacts for session: ${sessionId}, term: "${searchTerm}"`);
      
      const health = await this.checkSessionHealth(sessionId);
      if (!health.healthy) {
        return { contacts: [], error: health.reason };
      }

      const client = this.clients.get(sessionId);
      const [contacts, chats] = await Promise.all([
        client.getContacts(),
        client.getChats()
      ]);
      
      // Create a Set of numbers that have actual chat history
      const numbersWithChats = new Set();
      chats.forEach(chat => {
        if (!chat.isGroup && chat.id && chat.id.user) {
          numbersWithChats.add(chat.id.user);
        }
      });
      
      const searchLower = searchTerm.toLowerCase();
      
      // Filter and search contacts
      const matchingContacts = contacts
        .filter(contact => {
          if (!contact.id || !contact.id.user || contact.isGroup) return false;
          
          const hasName = contact.name || contact.pushname;
          const isRealContact = contact.isMyContact || numbersWithChats.has(contact.id.user);
          
          if (!hasName || !isRealContact) return false;
          
          // Search in name, pushname, or phone number
          const name = (contact.name || '').toLowerCase();
          const pushname = (contact.pushname || '').toLowerCase();
          const number = contact.id.user;
          
          return name.includes(searchLower) || 
                 pushname.includes(searchLower) || 
                 number.includes(searchTerm);
        })
        // Remove duplicates by both name and phone number
        .reduce((unique, contact) => {
          const phoneNumber = contact.id.user;
          const name = (contact.name || contact.pushname || '').toLowerCase().trim();
          
          // Check for duplicate by phone number OR by name (if name exists)
          const existingByPhone = unique.find(c => c.id.user === phoneNumber);
          const existingByName = name ? unique.find(c => {
            const existingName = (c.name || c.pushname || '').toLowerCase().trim();
            return existingName === name && existingName !== '';
          }) : null;
          
          const existing = existingByPhone || existingByName;
          
          if (!existing) {
            unique.push(contact);
          } else {
            // Keep the better contact
            const currentScore = this.getContactScore(contact);
            const existingScore = this.getContactScore(existing);
            
            if (currentScore > existingScore) {
              const index = unique.indexOf(existing);
              unique[index] = contact;
            }
          }
          
          return unique;
        }, [])
        // Sort by relevance (exact name matches first)
        .sort((a, b) => {
          const nameA = (a.name || a.pushname || '').toLowerCase();
          const nameB = (b.name || b.pushname || '').toLowerCase();
          
          const exactMatchA = nameA === searchLower ? 0 : nameA.startsWith(searchLower) ? 1 : 2;
          const exactMatchB = nameB === searchLower ? 0 : nameB.startsWith(searchLower) ? 1 : 2;
          
          if (exactMatchA !== exactMatchB) {
            return exactMatchA - exactMatchB;
          }
          
          return nameA.localeCompare(nameB);
        })
        // Limit results
        .slice(0, limit);

      console.log(`🔍 Found ${matchingContacts.length} matching contacts`);

      // Format contacts
      const formattedContacts = matchingContacts.map(contact => ({
        id: contact.id._serialized,
        name: contact.name || contact.pushname || 'Unknown',
        number: contact.id.user,
        isGroup: false,
        isMyContact: contact.isMyContact || false,
        profilePicUrl: contact.profilePicUrl || null,
        unreadCount: 0
      }));
      
      return {
        contacts: formattedContacts,
        totalFound: matchingContacts.length,
        searchTerm
      };
    } catch (error) {
      console.error(`❌ Error searching contacts for session ${sessionId}:`, error);
      return { contacts: [], error: error.message };
    }
  }

  // Add this helper method to the WhatsAppService class
  getContactScore(contact) {
    let score = 0;
    
    // Real name is best
    if (contact.name) {
      score += 100;
    }
    
    // Pushname is second best
    if (contact.pushname) {
      score += 50;
    }
    
    // Saved contact is better
    if (contact.isMyContact) {
      score += 25;
    }
    
    // Shorter phone numbers are usually better (real numbers vs WhatsApp IDs)
    const phoneLength = contact.id.user.length;
    if (phoneLength <= 15) { // Normal phone number length
      score += 20;
    } else {
      score -= 10; // Long WhatsApp internal IDs
    }
    
    // Has profile picture
    if (contact.profilePicUrl) {
      score += 5;
    }
    
    return score;
  }

  // Add automatic client restart every 2 hours to prevent memory leaks
  async restartOldClients() {
    console.log('🔄 Checking for old clients to restart...');
    
    for (const [sessionId, client] of this.clients.entries()) {
      try {
        // Restart clients that have been running for more than 4 hours
        const sessionData = await this.getSessionFromDB(sessionId);
        if (sessionData && sessionData.lastConnected) {
          const connectedTime = new Date(sessionData.lastConnected).getTime();
          const now = Date.now();
          const hoursRunning = (now - connectedTime) / (1000 * 60 * 60);
          
          if (hoursRunning > 4) {
            console.log(`🔄 Restarting client ${sessionId} (running for ${hoursRunning.toFixed(1)} hours)`);
            await this.recoverSession(sessionId);
          }
        }
      } catch (error) {
        console.error(`Error checking client age for ${sessionId}:`, error);
      }
    }
  }

}

module.exports = WhatsAppService;