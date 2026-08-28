#!/bin/bash
# Step 1: Stripe CLI Webhook Replay Verification
# Purpose: Prove S-1 and S-5 survive real Stripe delivery semantics

set -e

echo "═══════════════════════════════════════════════════════════════════"
echo "STEP 1: Stripe CLI Webhook Replay Verification"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Check server
if ! curl -s http://localhost:5000/health > /dev/null 2>&1; then
  echo "❌ Server not running on localhost:5000"
  echo "   Start with: npm run dev"
  exit 1
fi
echo "✅ Server running"

# Check Stripe CLI
if ! command -v stripe &> /dev/null; then
  echo "❌ Stripe CLI not found"
  exit 1
fi
echo "✅ Stripe CLI installed"

# Get webhook secret from Stripe CLI
echo ""
echo "📋 Starting Stripe CLI listener..."
echo "   This will forward webhooks to: http://localhost:5000/webhooks/stripe"
echo ""
echo "⚠️  IMPORTANT: In another terminal, run:"
echo "   stripe trigger customer.subscription.created"
echo "   (Note the event ID from output)"
echo "   stripe events resend <event_id>"
echo ""
echo "Press Ctrl+C after replaying the event twice"
echo ""

stripe listen --forward-to http://localhost:5000/webhooks/stripe
