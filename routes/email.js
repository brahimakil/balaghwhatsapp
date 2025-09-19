const express = require('express');
const router = express.Router();

// Update the test-connection route with better debugging
router.get('/test-connection', async (req, res) => {
  try {
    console.log('🔍 Email connection test requested');
    console.log('🔍 EmailService available:', !!req.emailService);
    console.log('🔍 EmailService initialized:', req.emailService?.initialized);
    
    if (!req.emailService) {
      throw new Error('Email service not available');
    }
    
    const result = await req.emailService.testConnection();
    res.json(result);
    
  } catch (error) {
    console.error('❌ Email connection test error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack
    });
  }
});

// Send test email
router.post('/send-test', async (req, res) => {
  try {
    const { email, message } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email address is required' 
      });
    }

    console.log('📧 Test email send requested for:', email);
    
    const result = await req.emailService.sendTestEmail(email, message);
    res.json(result);
    
  } catch (error) {
    console.error('Send test email error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Send notification email (for testing)
router.post('/send-notification-test', async (req, res) => {
  try {
    const { email, notification } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email address is required' 
      });
    }

    if (!notification) {
      return res.status(400).json({ 
        success: false, 
        error: 'Notification data is required' 
      });
    }

    console.log('🔔 Notification email test requested for:', email);
    
    const result = await req.emailService.sendNotificationEmail(email, notification);
    res.json(result);
    
  } catch (error) {
    console.error('Send notification email error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
