const express = require('express');
const router = express.Router();
const { getDb } = require('../config/firebase');
const admin = require('firebase-admin');
const NotificationEmailService = require('../services/notificationEmailService');

// Create notification with email automation
router.post('/create', async (req, res) => {
  try {
    const { 
      action, 
      entityType, 
      entityId, 
      entityName, 
      performedBy, 
      performedByName, 
      details, 
      villageId,
      performerRole 
    } = req.body;

    // Validate required fields
    if (!action || !entityType || !entityId || !entityName || !performedBy) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: action, entityType, entityId, entityName, performedBy' 
      });
    }

    console.log('🔔 Creating notification with email automation:', {
      action, entityType, entityName, performedBy
    });

    const db = getDb();
    
    // Create clean notification object
    const cleanNotification = {
      action,
      entityType,
      entityId,
      entityName,
      performedBy,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      readBy: [] // Empty array - nobody has read it yet
    };

    // Add optional fields if they exist
    if (performedByName && performedByName.trim()) {
      cleanNotification.performedByName = performedByName;
    }
    
    if (details && details.trim()) {
      cleanNotification.details = details;
    }

    if (villageId && villageId.trim()) {
      cleanNotification.villageId = villageId;
    }

    if (performerRole && performerRole.trim()) {
      cleanNotification.performerRole = performerRole;
    }

    // Save notification to Firestore
    const docRef = await db.collection('notifications').add(cleanNotification);
    console.log('✅ Notification saved to Firestore with ID:', docRef.id);

    // Send emails asynchronously (don't wait for completion)
    const notificationEmailService = new NotificationEmailService(req.emailService);
    
    // Convert timestamp for email service
    const notificationForEmail = {
      ...cleanNotification,
      id: docRef.id,
      timestamp: new Date()
    };

    // Send emails in background
    notificationEmailService.sendNotificationEmails(notificationForEmail)
      .then(result => {
        console.log('📬 Email automation completed:', result);
      })
      .catch(error => {
        console.error('❌ Email automation failed:', error);
      });

    res.json({ 
      success: true, 
      notificationId: docRef.id,
      message: 'Notification created and email automation started'
    });

  } catch (error) {
    console.error('❌ Error creating notification:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Test notification email automation
router.post('/test-automation', async (req, res) => {
  try {
    const testNotification = {
      id: 'test-notification',
      action: 'created',
      entityType: 'martyrs',
      entityId: 'test-martyr-id',
      entityName: 'Test Martyr Name',
      performedBy: 'test@example.com',
      performedByName: 'Test Admin',
      timestamp: new Date(),
      details: 'This is a test notification for email automation',
      villageId: req.body.villageId || null,
      readBy: []
    };

    console.log('🧪 Testing notification email automation');

    const notificationEmailService = new NotificationEmailService(req.emailService);
    const result = await notificationEmailService.sendNotificationEmails(testNotification);

    res.json({ 
      success: true, 
      result,
      message: 'Test notification email automation completed'
    });

  } catch (error) {
    console.error('❌ Error testing notification automation:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Route to send emails when a notification is created
router.post('/send-emails', async (req, res) => {
  try {
    console.log('📧 Email notification request received');
    
    const { notificationId, notification } = req.body;
    
    if (!notificationId || !notification) {
      return res.status(400).json({
        success: false,
        error: 'Missing notificationId or notification data'
      });
    }

    console.log('📋 Processing email notifications for:', {
      action: notification.action,
      entityType: notification.entityType,
      entityName: notification.entityName,
      performedBy: notification.performedBy
    });

    // Use the notification email service to send emails
    const results = await req.app.locals.notificationEmailService.sendNotificationEmails(
      notification,
      notificationId
    );

    console.log('✅ Email notification results:', results);

    res.json({
      success: true,
      results: results
    });

  } catch (error) {
    console.error('❌ Error sending notification emails:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
