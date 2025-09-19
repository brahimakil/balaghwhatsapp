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
    this.db = getDb();
    this.sessionId = 'simple_session';
    this.isConnected = false;
    
    // Create auth directory
    this.authDir = path.join(__dirname, '../auth_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  // 🔗 QR CODE LOGIN
  async connect() {
    try {
      console.log('📱 Starting WhatsApp connection...');
      
      if (this.client) {
        console.log('🔄 Destroying existing client...');
        await this.client.destroy();
        this.client = null;
        this.isConnected = false;
      }
      
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

      // QR Code event
      this.client.on('qr', async (qr) => {
        console.log('📋 QR Code generated');
        const qrCodeData = await qrcode.toDataURL(qr);
        this.io.emit('qr-code', { qrCode: qrCodeData });
      });

      // Ready event
      this.client.on('ready', () => {
        console.log('✅ WhatsApp connected!');
        this.isConnected = true;
        this.io.emit('whatsapp-ready');
      });

      // Disconnected event
      this.client.on('disconnected', (reason) => {
        console.log('📱 WhatsApp disconnected:', reason);
        this.isConnected = false;
        this.io.emit('whatsapp-disconnected', { reason });
      });

      // Auth failure event
      this.client.on('auth_failure', (msg) => {
        console.error('❌ WhatsApp auth failed:', msg);
        this.isConnected = false;
        this.io.emit('whatsapp-auth-failed', { reason: msg });
      });

      await this.client.initialize();
      return { success: true };
      
    } catch (error) {
      console.error('❌ Connection error:', error);
      this.isConnected = false;
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

      const contact = {
        name: name.trim(),
        phone: cleanPhone,
        email: email.trim(),
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
      let csv = 'Name,Phone,Email\n';
      
      contacts.forEach(contact => {
        csv += `"${contact.name}","${contact.phone}","${contact.email || ''}"\n`;
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

  // ➕ CREATE GROUP
  async createGroup(groupName, contactIds) {
    try {
      // Get contacts
      const contacts = [];
      for (const contactId of contactIds) {
        const contactDoc = await this.db.collection('whatsapp_contacts').doc(contactId).get();
        if (contactDoc.exists) {
          contacts.push({ id: contactId, ...contactDoc.data() });
        }
      }

      if (contacts.length === 0) {
        throw new Error('No valid contacts found for group');
      }

      const group = {
        name: groupName.trim(),
        contacts: contacts,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      const docRef = await this.db.collection('whatsapp_groups').add(group);
      console.log(`✅ Group created: ${groupName} with ${contacts.length} contacts`);
      
      return { success: true, id: docRef.id, ...group };
    } catch (error) {
      console.error('❌ Error creating group:', error);
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

  // 📤 SEND MESSAGE TO SINGLE CONTACT
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
      const chatId = `${contact.phone}@c.us`;
      
      // Check if number is registered on WhatsApp
      const isRegistered = await this.client.isRegisteredUser(chatId);
      if (!isRegistered) {
        throw new Error(`${contact.phone} is not registered on WhatsApp`);
      }

      await this.client.sendMessage(chatId, message);
      console.log(`✅ Message sent to ${contact.name} (${contact.phone})`);
      
      return { success: true, contact };
    } catch (error) {
      console.error(`❌ Error sending to contact:`, error);
      throw error;
    }
  }

  // 📤 SEND MESSAGE TO MULTIPLE CONTACTS
  async sendToContacts(contactIds, message) {
    try {
      if (!this.isWhatsAppConnected()) {
        throw new Error('WhatsApp is not connected. Please connect first.');
      }

      const results = { success: [], failed: [] };

      for (const contactId of contactIds) {
        try {
          const result = await this.sendToContact(contactId, message);
          results.success.push(result.contact);
          
          // Delay between messages to avoid spam detection
          await new Promise(resolve => setTimeout(resolve, 2000));
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

      return results;
    } catch (error) {
      console.error('❌ Error sending to contacts:', error);
      throw error;
    }
  }

  // 📤 SEND MESSAGE TO GROUP
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
      const results = { success: [], failed: [] };

      for (const contact of group.contacts) {
        try {
          const chatId = `${contact.phone}@c.us`;
          
          // Check if number is registered
          const isRegistered = await this.client.isRegisteredUser(chatId);
          if (!isRegistered) {
            results.failed.push({ contact, error: 'Not registered on WhatsApp' });
            continue;
          }
          
          await this.client.sendMessage(chatId, message);
          results.success.push(contact);
          console.log(`✅ Sent to ${contact.name}`);
          
          // Delay between messages
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`❌ Failed to send to ${contact.name}:`, error);
          results.failed.push({ contact, error: error.message });
        }
      }

      return results;
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

  // 🛑 DISCONNECT
  async disconnect() {
    try {
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      this.isConnected = false;
      console.log('✅ WhatsApp disconnected');
    } catch (error) {
      console.error('❌ Disconnect error:', error);
    }
  }
}

module.exports = SimpleWhatsAppService;
