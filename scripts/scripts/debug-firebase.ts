/**
 * Firebase Debug Script
 * Run this to diagnose API key issues
 */

console.log('='.repeat(60));
console.log('FIREBASE CONFIGURATION DIAGNOSTIC');
console.log('='.repeat(60));

// Check environment variables
console.log('\n📋 Environment Variables:');
console.log('EXPO_PUBLIC_FIREBASE_API_KEY:', process.env.EXPO_PUBLIC_FIREBASE_API_KEY ? '✅ Set' : '❌ Not set');
console.log('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN:', process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ? '✅ Set' : '❌ Not set');
console.log('EXPO_PUBLIC_FIREBASE_PROJECT_ID:', process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ? '✅ Set' : '❌ Not set');

if (process.env.EXPO_PUBLIC_FIREBASE_API_KEY) {
  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
  console.log('\n🔑 API Key Analysis:');
  console.log('Length:', apiKey.length, apiKey.length === 39 ? '✅ Correct' : '❌ Should be 39');
  console.log('First 10 chars:', apiKey.substring(0, 10));
  console.log('Last 10 chars:', apiKey.substring(apiKey.length - 10));
  console.log('Has leading space:', apiKey[0] === ' ' ? '❌ YES - FIX THIS' : '✅ No');
  console.log('Has trailing space:', apiKey[apiKey.length - 1] === ' ' ? '❌ YES - FIX THIS' : '✅ No');
  console.log('Has newline:', apiKey.includes('\n') ? '❌ YES - FIX THIS' : '✅ No');
  console.log('Has quotes:', apiKey.includes('"') || apiKey.includes("'") ? '❌ YES - FIX THIS' : '✅ No');
}

console.log('\n🌐 Platform Info:');
console.log('Platform:', require('react-native').Platform.OS);
console.log('Is Dev:', __DEV__);

console.log('\n🧪 Firebase SDK Test:');
try {
  const { initializeFirebase } = require('../lib/firebase');
  initializeFirebase();
  console.log('✅ Firebase initialized successfully');
} catch (error: any) {
  console.log('❌ Firebase initialization failed:', error.message);
}

console.log('\n' + '='.repeat(60));
console.log('Copy this output and share if you need help');
console.log('='.repeat(60));
