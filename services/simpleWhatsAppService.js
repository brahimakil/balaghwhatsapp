const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getDb } = require('../config/firebase');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

class SimpleWhatsAppService {
  constructor(io) {
    this.io = io;
    this.client = null;
    this.db = null; // Initialize as null
    this.sessionId = 'simple_session';
    this.isConnected = false;
    this.keepAliveInterval = null;
    this.contactsSynced = false;
    
    // Initialize database immediately
    try {
      const { getDb } = require('../config/firebase');
      this.db = getDb();
      console.log('✅ Database initialized in WhatsApp service');
    } catch (error) {
      console.error('❌ Failed to initialize database:', error);
      this.db = null;
    }
    
    // Create auth directory
    this.authDir = path.join(__dirname, '../auth_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    
    // Auto-restore session on startup
    this.autoRestore();
  }

  // 🔄 AUTO-RESTORE SESSION ON STARTUP
  async autoRestore() {
    try {
      console.log('🔄 Checking for existing WhatsApp session...');
      
      // Check if we have auth data saved
      const authPath = path.join(this.authDir, `session-${this.sessionId}`);
      if (fs.existsSync(authPath)) {
        console.log('📱 Found existing auth data, auto-connecting...');
        await this.connect(true); // true = silent restore
      } else {
        console.log('📱 No existing session found');
      }
    } catch (error) {
      console.error('❌ Auto-restore failed:', error);
    }
  }

  // 🔗 CONNECT (with auto-restore support)
  async connect(isRestore = false) {
    try {
      console.log(`🔗 ${isRestore ? 'Restoring' : 'Creating new'} WhatsApp connection...`);
      
      if (this.client) {
        console.log('🔄 Destroying existing client...');
        try {
        await this.client.destroy();
    } catch (error) {
          console.log(`⚠️ Error destroying existing client: ${error.message}`);
        }
      }

      const { Client, LocalAuth } = require('whatsapp-web.js');
      
      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.sessionId,
          dataPath: this.authDir
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
          ]
        }
      });

      // QR Code event (only for new connections)
      this.client.on('qr', async (qr) => {
        if (!isRestore) {
          console.log('📋 QR Code generated');
          const qrCodeData = await qrcode.toDataURL(qr);
          this.io.emit('qr-code', { qrCode: qrCodeData });
        }
      });

      // Ready event
      this.client.on('ready', async () => {
        console.log('✅ WhatsApp connected!');
        this.isConnected = true;
        
        // Save session to Firebase
        await this.saveSessionToFirebase();
        
        // Start keep-alive ping
        this.startKeepAlive();
        
        this.io.emit('whatsapp-ready');
      });

      // Disconnected event
      this.client.on('disconnected', async (reason) => {
        console.log('📱 WhatsApp disconnected:', reason);
        this.isConnected = false;
        
        // Update session status in Firebase
        await this.updateSessionStatus('disconnected', reason);
        
        this.io.emit('whatsapp-disconnected', { 
          reason,
          requiresReconnection: true 
        });
      });

      // Auth failure event
      this.client.on('auth_failure', async (msg) => {
        console.error('❌ WhatsApp auth failed:', msg);
        this.isConnected = false;
        
        // Clear saved session
        await this.clearSessionFromFirebase();
        
        this.io.emit('whatsapp-auth-failed', { 
          reason: msg,
          requiresReconnection: true 
        });
      });

      await this.client.initialize();
      return { success: true };
      
    } catch (error) {
      console.error('❌ Connection error:', error);
      this.isConnected = false;
      
      // If connection fails, emit event requiring reconnection
      this.io.emit('whatsapp-disconnected', { 
        reason: error.message,
        requiresReconnection: true 
      });
      
      throw error;
    }
  }

  // 💾 SAVE SESSION TO FIREBASE
  async saveSessionToFirebase() {
    try {
      const sessionData = {
        sessionId: this.sessionId,
        status: 'connected',
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      };

      await this.db.collection('whatsapp_sessions').doc(this.sessionId).set(sessionData);
      console.log('💾 Session saved to Firebase');
    } catch (error) {
      console.error('❌ Error saving session to Firebase:', error);
    }
  }

  // 📝 UPDATE SESSION STATUS
  async updateSessionStatus(status, reason = null) {
    try {
      const updateData = {
        status,
        lastActivity: admin.firestore.FieldValue.serverTimestamp()
      };

      if (reason) {
        updateData.disconnectReason = reason;
        updateData.disconnectedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await this.db.collection('whatsapp_sessions').doc(this.sessionId).update(updateData);
      console.log(`📝 Session status updated: ${status}`);
    } catch (error) {
      console.error('❌ Error updating session status:', error);
    }
  }

  // 🗑️ CLEAR SESSION FROM FIREBASE
  async clearSessionFromFirebase() {
    try {
      await this.db.collection('whatsapp_sessions').doc(this.sessionId).delete();
      
      // Clear auth files
      const authPath = path.join(this.authDir, `session-${this.sessionId}`);
      if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
      }
      
      console.log('🗑️ Session cleared from Firebase and local storage');
    } catch (error) {
      console.error('❌ Error clearing session:', error);
    }
  }

  // 📱 AUTO-SYNC CONTACTS FROM WHATSAPP (DISABLED)
  async autoSyncContacts() {
    try {
      console.log('📱 Contact syncing is DISABLED - skipping...');
      this.contactsSynced = true;
      return;
    } catch (error) {
      console.error('❌ Error in autoSyncContacts:', error);
    }
  }

  // 🔄 FORCE RESYNC CONTACTS
  async resyncContacts() {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected');
      }

      // Clear existing sync status
      await this.db.collection('whatsapp_sync').doc('contacts_sync').delete();
      
      // Clear existing synced contacts
      const existingContacts = await this.db.collection('whatsapp_contacts')
        .where('syncedFromWhatsApp', '==', true)
        .get();
      
      const batch = this.db.batch();
      existingContacts.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();

      // Resync
      await this.autoSyncContacts();
      
      return { success: true, message: 'Contacts resynced successfully' };
    } catch (error) {
      console.error('❌ Error resyncing contacts:', error);
      throw error;
    }
  }

  // ✅ Check if WhatsApp is connected
  isWhatsAppConnected() {
    return this.client && this.isConnected;
  }

  // 📇 GET ALL CONTACTS
  async getContacts() {
    try {
      if (!this.db) {
        throw new Error('Database not initialized');
      }
      
      const snapshot = await this.db.collection('whatsapp_contacts').get();
      const contacts = [];
      
      snapshot.forEach(doc => {
        contacts.push({ id: doc.id, ...doc.data() });
      });
      
      return contacts;
    } catch (error) {
      console.error('❌ Error getting contacts:', error);
      throw error;
    }
  }

  // ➕ ADD CONTACT MANUALLY
  async addContact(name, phone, email = '') {
    try {
      // Clean phone number
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.length < 10) {
        throw new Error('Phone number must be at least 10 digits');
      }

      // Check if contact already exists
      const existingContact = await this.db.collection('whatsapp_contacts')
        .where('phone', '==', cleanPhone)
        .get();
      
      if (!existingContact.empty) {
        throw new Error('Contact with this phone number already exists');
      }

      const contact = {
        name: name.trim(),
        phone: cleanPhone,
        email: email.trim(),
        syncedFromWhatsApp: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      const docRef = await this.db.collection('whatsapp_contacts').add(contact);
      console.log(`✅ Contact added: ${name} (${cleanPhone})`);
      
      return { success: true, id: docRef.id, ...contact };
    } catch (error) {
      console.error('❌ Error adding contact:', error);
      throw error;
    }
  }

  // 🗑️ DELETE CONTACT
  async deleteContact(contactId) {
    try {
      await this.db.collection('whatsapp_contacts').doc(contactId).delete();
      console.log(`✅ Contact deleted: ${contactId}`);
      return { success: true };
    } catch (error) {
      console.error('❌ Error deleting contact:', error);
      throw error;
    }
  }

  // 📥 IMPORT CONTACTS FROM CSV
  async importContacts(csvData) {
    try {
      const contacts = this.parseCSV(csvData);
      const results = { success: [], failed: [] };
      
      for (const contact of contacts) {
        try {
          const result = await this.addContact(contact.name, contact.phone, contact.email);
          results.success.push(result);
        } catch (error) {
          results.failed.push({ contact, error: error.message });
        }
      }
      
      console.log(`📥 Import complete: ${results.success.length} success, ${results.failed.length} failed`);
      return results;
    } catch (error) {
      console.error('❌ Import error:', error);
      throw error;
    }
  }

  // 📤 EXPORT CONTACTS TO CSV
  async exportContacts() {
    try {
      const contacts = await this.getContacts();
      let csv = 'Name,Phone,Email,Source\n';
      
      contacts.forEach(contact => {
        const source = contact.syncedFromWhatsApp ? 'WhatsApp' : 'Manual';
        csv += `"${contact.name}","${contact.phone}","${contact.email || ''}","${source}"\n`;
      });
      
      return csv;
    } catch (error) {
      console.error('❌ Export error:', error);
      throw error;
    }
  }

  // 👥 GET ALL GROUPS
  async getGroups() {
    try {
      if (!this.db) {
        throw new Error('Database not initialized');
      }
      
      const snapshot = await this.db.collection('whatsapp_groups').get();
      const groups = [];
      
      snapshot.forEach(doc => {
        groups.push({ id: doc.id, ...doc.data() });
      });
      
      return groups;
    } catch (error) {
      console.error('❌ Error getting groups:', error);
      throw error;
    }
  }

  // ➕ CREATE REAL WHATSAPP GROUP
  async createGroup(groupName, contactIds) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      // Get contacts from database
      const contacts = [];
      const whatsappNumbers = [];
      
      for (const contactId of contactIds) {
        const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
        if (contactDoc.exists) {
          const contact = contactDoc.data();
          contacts.push({ id: contactId, ...contact });
          
          // Format phone number for WhatsApp
          const formattedNumber = this.formatPhoneNumber(contact.phone);
          whatsappNumbers.push(`${formattedNumber}@c.us`);
        }
      }

      if (contacts.length === 0) {
        throw new Error('No valid contacts found for group');
      }

      console.log(`📱 Creating WhatsApp group: ${groupName} with ${contacts.length} members`);
      
      // Create actual WhatsApp group
      const whatsappGroup = await this.client.createGroup(groupName.trim(), whatsappNumbers);
      
      console.log(`✅ WhatsApp group created successfully!`);
      console.log(`📱 Group ID: ${whatsappGroup.gid._serialized}`);
      
      // Save group info to database
      const group = {
        name: groupName.trim(),
        contacts: contacts,
        whatsappGroupId: whatsappGroup.gid._serialized, // Save real WhatsApp group ID
        whatsappInviteCode: whatsappGroup.inviteCode || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      const docRef = await this.db.collection('whatsapp_groups').add(group);
      console.log(`💾 Group saved to database: ${docRef.id}`);
      
      return { 
        success: true, 
        id: docRef.id, 
        whatsappGroupId: whatsappGroup.gid._serialized,
        inviteCode: whatsappGroup.inviteCode,
        ...group 
      };
      
    } catch (error) {
      console.error('❌ Error creating WhatsApp group:', error);
      throw error;
    }
  }

  // 🗑️ DELETE GROUP
  async deleteGroup(groupId) {
    try {
      await this.db.collection('whatsapp_groups').doc(groupId).delete();
      console.log(`✅ Group deleted: ${groupId}`);
      return { success: true };
    } catch (error) {
      console.error('❌ Error deleting group:', error);
      throw error;
    }
  }

  // 📤 SEND MESSAGE TO SINGLE CONTACT (WITH AUTO-RECONNECT)
  async sendToContact(contactId, message) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
      if (!contactDoc.exists) {
        throw new Error('Contact not found');
      }

      const contact = contactDoc.data();
      console.log(`📤 Attempting to send to: ${contact.name} (${contact.phone})`);
      
      const formattedNumber = this.formatPhoneNumber(contact.phone);
      console.log(`📱 Cleaned phone: ${formattedNumber}`);
      
      const chatId = `${formattedNumber}@c.us`;
      
      try {
        console.log(`📱 Sending message to ${chatId}...`);
        await this.client.sendMessage(chatId, message);
        console.log(`✅ Message sent successfully to ${contact.name}`);
        
        return { success: true, contact };
        
      } catch (sendError) {
        console.error(`❌ Send failed for ${contact.name}:`, sendError.message);
        
        // Check if it's a session/connection error
        if (this.isConnectionError(sendError)) {
          console.log(`🔄 Connection error detected. Triggering reconnection...`);
          await this.handleConnectionError();
          throw new Error(`Connection lost. Please reconnect WhatsApp.`);
        }
        
        throw new Error(`Message send failed: ${sendError.message}`);
      }
      
    } catch (error) {
      console.error(`❌ Error sending to contact:`, error);
      throw error;
    }
  }

  // 🔍 CHECK IF ERROR IS CONNECTION-RELATED
  isConnectionError(error) {
    const connectionErrorMessages = [
      'Protocol error',
      'Session closed',
      'page has been closed',
      'Target closed',
      'Connection terminated',
      'Navigation failed',
      'browser has disconnected'
    ];
    
    return connectionErrorMessages.some(msg => 
      error.message.toLowerCase().includes(msg.toLowerCase())
    );
  }

  // 🔄 HANDLE CONNECTION ERRORS
  async handleConnectionError() {
    try {
      console.log(`🚨 Connection error detected! Disconnecting and preparing for reconnection...`);
      
      // Mark as disconnected
      this.isConnected = false;
      
      // Stop keep-alive
      this.stopKeepAlive();
      
      // Emit disconnection event
      this.io.emit('whatsapp-disconnected', { 
        reason: 'Connection error - please reconnect',
        requiresReconnection: true 
      });
      
      // Try to disconnect cleanly
      try {
        if (this.client) {
          await this.client.destroy();
        }
      } catch (destroyError) {
        console.log(`⚠️ Error during client destruction: ${destroyError.message}`);
      }
      
      // Clear the client
      this.client = null;
      
      // Clear session from Firebase
      await this.clearSessionFromFirebase();
      
      console.log(`✅ Disconnection complete. Ready for reconnection.`);
      
    } catch (error) {
      console.error(`❌ Error handling connection error:`, error);
    }
  }

  // 📤 SEND MESSAGE TO MULTIPLE CONTACTS (IMPROVED)
  async sendToContacts(contactIds, message) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      console.log(`📤 Starting bulk send to ${contactIds.length} contacts`);
      const results = { success: [], failed: [] };

      for (let i = 0; i < contactIds.length; i++) {
        const contactId = contactIds[i];
        
        try {
          console.log(`📤 Sending ${i + 1}/${contactIds.length}...`);
          const result = await this.sendToContact(contactId, message);
          results.success.push(result.contact);
          
          // Delay between messages to avoid spam detection
          if (i < contactIds.length - 1) {
            console.log(`⏳ Waiting 3 seconds before next message...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
        } catch (error) {
          const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
          const contactName = contactDoc.exists ? contactDoc.data().name : 'Unknown';
          
          console.error(`❌ Failed to send to ${contactName}:`, error.message);
          results.failed.push({ 
            contactId, 
            name: contactName, 
            error: error.message 
          });
        }
      }

      console.log(`📊 Bulk send complete: ${results.success.length} success, ${results.failed.length} failed`);
      return results;
      
    } catch (error) {
      console.error('❌ Error sending to contacts:', error);
      throw error;
    }
  }

  // 📤 SEND MESSAGE TO WHATSAPP GROUP (UPDATED)
  async sendToGroup(groupId, message) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const groupDoc = await this.db.collection('whatsapp_groups').doc(groupId).get();
      if (!groupDoc.exists) {
        throw new Error('Group not found');
      }

      const group = groupDoc.data();
      
      // If it's a real WhatsApp group, send to the group directly
      if (group.whatsappGroupId) {
        console.log(`📤 Sending to WhatsApp group: ${group.name} (${group.whatsappGroupId})`);
        
        try {
          await this.client.sendMessage(group.whatsappGroupId, message);
          console.log(`✅ Message sent to WhatsApp group: ${group.name}`);
          
          return {
            success: [{ contact: `Group: ${group.name}`, groupId: group.whatsappGroupId }],
            failed: []
          };
        } catch (error) {
          console.error(`❌ Failed to send to WhatsApp group: ${error.message}`);
          return {
            success: [],
            failed: [{ contact: `Group: ${group.name}`, error: error.message }]
          };
        }
      } 
      // Fallback: send to individual contacts if no WhatsApp group ID
      else {
        console.log(`📤 Sending to group contacts individually: ${group.name} with ${group.contacts.length} contacts`);
        
        const results = { success: [], failed: [] };
        const contacts = group.contacts || [];
        
        for (let i = 0; i < contacts.length; i++) {
          const contact = contacts[i];
          console.log(`📤 Sending to ${contact.name} (${i + 1}/${contacts.length})`);
          
          try {
            const formattedNumber = this.formatPhoneNumber(contact.phone);
            const chatId = `${formattedNumber}@c.us`;
            
            await this.client.sendMessage(chatId, message);
            console.log(`✅ Sent to ${contact.name}`);
            results.success.push({ contact: contact.name, phone: contact.phone });
            
            // Add delay between messages to avoid spam detection
            if (i < contacts.length - 1) {
              console.log('⏳ Waiting 3 seconds...');
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          } catch (error) {
            console.error(`❌ Failed to send to ${contact.name}: ${error.message}`);
            results.failed.push({ contact: contact.name, phone: contact.phone, error: error.message });
          }
        }
        
        console.log(`📊 Group send complete: ${results.success.length} success, ${results.failed.length} failed`);
        return results;
      }
    } catch (error) {
      console.error('❌ Error sending to group:', error);
      throw error;
    }
  }

  // 📤 SEND MESSAGE TO MIXED SELECTION (contacts + groups)
  async sendToSelection(contactIds, groupIds, message) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const results = { 
        contactResults: { success: [], failed: [] },
        groupResults: { success: [], failed: [] }
      };

      // Send to individual contacts
      if (contactIds && contactIds.length > 0) {
        results.contactResults = await this.sendToContacts(contactIds, message);
      }

      // Send to groups
      if (groupIds && groupIds.length > 0) {
        for (const groupId of groupIds) {
          try {
            const groupResult = await this.sendToGroup(groupId, message);
            results.groupResults.success.push({
              groupId,
              contactResults: groupResult
            });
          } catch (error) {
            results.groupResults.failed.push({
              groupId,
              error: error.message
            });
          }
        }
      }

      return results;
    } catch (error) {
      console.error('❌ Error sending to selection:', error);
      throw error;
    }
  }

  // 🔧 UTILITY: Parse CSV
  parseCSV(csvData) {
    const lines = csvData.split('\n');
    const contacts = [];
    
    for (let i = 1; i < lines.length; i++) { // Skip header
      const line = lines[i].trim();
      if (!line) continue;
      
      const parts = line.split(',');
      if (parts.length >= 2) {
        contacts.push({
          name: parts[0].replace(/"/g, '').trim(),
          phone: parts[1].replace(/"/g, '').trim(),
          email: parts[2] ? parts[2].replace(/"/g, '').trim() : ''
        });
      }
    }
    
    return contacts;
  }

  // 🛑 IMPROVED DISCONNECT METHOD
  async disconnect() {
    try {
      console.log('🛑 Disconnecting WhatsApp...');
      
      this.isConnected = false;
      
      // Stop keep-alive
      this.stopKeepAlive();
      
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      
      // Clear session from Firebase
      await this.clearSessionFromFirebase();
      
      this.io.emit('whatsapp-disconnected', { 
        reason: 'Manual disconnection',
        requiresReconnection: false 
      });
      
      console.log('✅ WhatsApp disconnected successfully');
      return { success: true };
    } catch (error) {
      console.error('❌ Error disconnecting WhatsApp:', error);
      throw error;
    }
  }

  // 🗑️ LOGOUT (completely remove session)
  async logout() {
    try {
      if (this.client) {
        await this.client.logout();
        this.client = null;
      }
      this.isConnected = false;
      
      // Clear everything
      await this.clearSessionFromFirebase();
      
      console.log('✅ WhatsApp logged out completely');
    } catch (error) {
      console.error('❌ Logout error:', error);
    }
  }

  // 🗑️ CLEAR ALL SYNCED CONTACTS
  async clearAllSyncedContacts() {
    try {
      console.log('🗑️ Clearing all synced contacts from Firebase...');
      
      // Delete all contacts that were synced from WhatsApp
      const syncedContacts = await this.db.collection('whatsapp_contacts')
        .where('syncedFromWhatsApp', '==', true)
        .get();
      
      const batch = this.db.batch();
      syncedContacts.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      
      // Clear sync status
      await this.db.collection('whatsapp_sync').doc('contacts_sync').delete();
      
      console.log(`🗑️ Deleted ${syncedContacts.size} synced contacts`);
      return { success: true, deletedCount: syncedContacts.size };
      
    } catch (error) {
      console.error('❌ Error clearing synced contacts:', error);
      throw error;
    }
  }

  // 🔧 UTILITY: Format phone number for WhatsApp
  formatPhoneNumber(phone) {
    let cleanPhone = phone.replace(/\D/g, ''); // Remove all non-digits
    if (cleanPhone.length === 8) {
      cleanPhone = '961' + cleanPhone; // Add Lebanon country code
    } else if (cleanPhone.length === 10) {
      cleanPhone = '96' + cleanPhone;
    }
    return cleanPhone;
  }

  // 📤 SEND IMAGE TO CONTACT (FIXED)
  async sendImageToContact(contactId, imageUrl) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
      if (!contactDoc.exists) {
        throw new Error('Contact not found');
      }

      const contact = contactDoc.data();
      const formattedNumber = this.formatPhoneNumber(contact.phone);
      const chatId = `${formattedNumber}@c.us`;

      // Use MessageMedia.fromUrl for external URLs
      const { MessageMedia } = require('whatsapp-web.js');
      const media = await MessageMedia.fromUrl(imageUrl);
      
      await this.client.sendMessage(chatId, media);

      console.log(`🖼️ Image sent to ${contact.name}`);
      return { success: true, contact: contact.name };
    } catch (error) {
      console.error(`❌ Failed to send image to contact: ${error.message}`);
      throw error;
    }
  }

  // 📤 SEND IMAGE TO GROUP (FIXED)
  async sendImageToGroup(groupId, imageUrl) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const groupDoc = await this.db.collection('whatsapp_groups').doc(groupId).get();
      if (!groupDoc.exists) {
        throw new Error('Group not found');
      }

      const group = groupDoc.data();

      // If it's a real WhatsApp group, send to the group directly
      if (group.whatsappGroupId) {
        const { MessageMedia } = require('whatsapp-web.js');
        const media = await MessageMedia.fromUrl(imageUrl);
        
        await this.client.sendMessage(group.whatsappGroupId, media);
        console.log(`🖼️ Image sent to WhatsApp group: ${group.name}`);
        return { success: true, group: group.name };
      } else {
        // Send to individual contacts
        for (const contact of group.contacts || []) {
          await this.sendImageToContact(contact.id, imageUrl);
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay between contacts
        }
        return { success: true, group: group.name };
      }
    } catch (error) {
      console.error(`❌ Failed to send image to group: ${error.message}`);
      throw error;
    }
  }

  // 📤 SEND VIDEO TO CONTACT (FIXED)
  async sendVideoToContact(contactId, videoUrl) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
      if (!contactDoc.exists) {
        throw new Error('Contact not found');
      }

      const contact = contactDoc.data();
      const formattedNumber = this.formatPhoneNumber(contact.phone);
      const chatId = `${formattedNumber}@c.us`;

      // Use MessageMedia.fromUrl for videos
      const { MessageMedia } = require('whatsapp-web.js');
      const media = await MessageMedia.fromUrl(videoUrl);
      
      await this.client.sendMessage(chatId, media);

      console.log(`🎥 Video sent to ${contact.name}`);
      return { success: true, contact: contact.name };
    } catch (error) {
      console.error(`❌ Failed to send video to contact: ${error.message}`);
      throw error;
    }
  }

  // 📤 SEND VIDEO TO GROUP (FIXED)
  async sendVideoToGroup(groupId, videoUrl) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const groupDoc = await this.db.collection('whatsapp_groups').doc(groupId).get();
      if (!groupDoc.exists) {
        throw new Error('Group not found');
      }

      const group = groupDoc.data();

      // If it's a real WhatsApp group, send to the group directly
      if (group.whatsappGroupId) {
        const { MessageMedia } = require('whatsapp-web.js');
        const media = await MessageMedia.fromUrl(videoUrl);
        
        await this.client.sendMessage(group.whatsappGroupId, media);
        console.log(`🎥 Video sent to WhatsApp group: ${group.name}`);
        return { success: true, group: group.name };
      } else {
        // Send to individual contacts
        for (const contact of group.contacts || []) {
          await this.sendVideoToContact(contact.id, videoUrl);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return { success: true, group: group.name };
      }
    } catch (error) {
      console.error(`❌ Failed to send video to group: ${error.message}`);
      throw error;
    }
  }

  // ⏰ START KEEP-ALIVE PING
  startKeepAlive() {
    // Clear any existing interval
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }

    this.keepAliveInterval = setInterval(async () => {
      try {
        if (this.client && this.isConnected) {
          // Ping WhatsApp to keep session alive
          await this.client.getState();
          console.log("✅ Keep-alive ping successful");
        }
      } catch (error) {
        console.error("⚠️ Keep-alive failed - session lost:", error.message);
        
        // Session is dead, trigger auto-reconnection
        if (this.isConnectionError(error)) {
          console.log("🔄 Auto-reconnecting due to keep-alive failure...");
          await this.handleConnectionError();
        }
      }
    }, 1000 * 60 * 3); // Every 3 minutes

    console.log("⏰ Keep-alive started (3-minute intervals)");
  }

  // ⏹️ STOP KEEP-ALIVE
  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      console.log("⏹️ Keep-alive stopped");
    }
  }

  getDatabase() {
    if (!this.db) {
      const { getDb } = require('../config/firebase');
      this.db = getDb();
    }
    return this.db;
  }
}

module.exports = SimpleWhatsAppService;
