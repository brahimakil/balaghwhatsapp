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
            '--disable-gpu'
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
        this.io.emit('whatsapp-ready');
      });

      // Disconnected event
      this.client.on('disconnected', () => {
        console.log('📱 WhatsApp disconnected');
        this.io.emit('whatsapp-disconnected');
      });

      await this.client.initialize();
      return { success: true };
      
    } catch (error) {
      console.error('❌ Connection error:', error);
      throw error;
    }
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
      const contact = {
        name,
        phone,
        email,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      
      const docRef = await this.db.collection('whatsapp_contacts').add(contact);
      console.log(`✅ Contact added: ${name} (${phone})`);
      
      return { success: true, id: docRef.id, ...contact };
    } catch (error) {
      console.error('❌ Error adding contact:', error);
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

      const group = {
        name: groupName,
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

  // 📤 SEND MESSAGE TO GROUP
  async sendToGroup(groupId, message) {
    try {
      if (!this.client) {
        throw new Error('WhatsApp not connected');
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
      console.log('✅ WhatsApp disconnected');
    } catch (error) {
      console.error('❌ Disconnect error:', error);
    }
  }
}

module.exports = SimpleWhatsAppService;
