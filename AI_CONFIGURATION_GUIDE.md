# AI Configuration Guide

## Issue Summary

The error **"[AI Client] Error: Load failed"** occurs because:

1. **No AI provider API keys are configured** in the backend environment
2. The AI orchestration system requires at least one AI provider to function
3. Without API keys, the AI router falls back to simple pattern-matching responses

## Current Backend Configuration

Your `env.backend` file has empty values for all AI providers:

```bash
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
QWEN_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
```

## Solution Options

### Option 1: Add AI Provider API Keys (Recommended)

Choose one or more AI providers and add their API keys to `env.backend`:

#### 1. **Groq (FREE - Fastest & Best for Beta)**
- Website: https://groq.com
- Sign up and get free API key
- Add to env.backend:
  ```bash
  GROQ_API_KEY=gsk_your_key_here
  ```
- **Recommended**: Fast inference, free tier, great for chat

#### 2. **DeepSeek (Cheapest)**
- Website: https://platform.deepseek.com
- Very affordable pricing ($0.27/M tokens)
- Add to env.backend:
  ```bash
  DEEPSEEK_API_KEY=sk-your_key_here
  ```
- Good for reasoning tasks

#### 3. **OpenRouter (Flexible)**
- Website: https://openrouter.ai
- Access to multiple models
- Pay-as-you-go
- Add to env.backend:
  ```bash
  OPENROUTER_API_KEY=sk-or-your_key_here
  ```
- Good for variety of tasks

#### 4. **OpenAI (Most Reliable)**
- Website: https://platform.openai.com
- Industry standard
- Add to env.backend:
  ```bash
  OPENAI_API_KEY=sk-your_key_here
  ```
- Best quality but most expensive

### Option 2: Use Built-in Fallback Responses

The system now works without AI providers using rule-based responses:

**Pros:**
- No API costs
- Instant responses
- No external dependencies
- Good for basic onboarding flow

**Cons:**
- Limited intelligence
- No personalization
- Cannot handle complex queries
- Pattern-matching only

The fallback system handles:
- ✅ Onboarding flow (works fully)
- ✅ Basic task discovery
- ✅ Simple help requests
- ❌ Complex conversations
- ❌ Task categorization
- ❌ Price validation
- ❌ Translation

## How the AI Router Works

```typescript
// backend/ai/router.ts

1. Request comes in → Routes to appropriate AI model
2. If API key exists → Calls external AI provider
3. If NO API key → Falls back to pattern-matching
4. Returns response (either AI-generated or fallback)
```

### Model Routing Logic

```typescript
- 'translate' → qwen3-22b (OpenRouter)
- 'chat' → qwen3-22b (OpenRouter) 
- 'reason' → deepseek-r1 (DeepSeek)
- 'critical' → gpt-4o (OpenAI)
- default → groq-llama (Groq)
```

## Recommended Setup for Beta Launch

### Minimal Cost Setup
```bash
# Add ONLY Groq - it's free!
GROQ_API_KEY=gsk_your_key_here
```

This will handle:
- Chat interactions
- General queries
- Default routing

### Production-Ready Setup
```bash
# Multiple providers for redundancy
GROQ_API_KEY=gsk_your_key_here          # Fast chat (free)
DEEPSEEK_API_KEY=sk-your_key_here       # Reasoning ($)
OPENROUTER_API_KEY=sk-or-your_key_here  # Translation ($)
```

## Backend Environment Setup

### 1. Edit env.backend file
```bash
cd /home/user/rork-app
nano env.backend  # or use any editor
```

### 2. Add your API key(s)
Replace the empty values:
```bash
# Before
GROQ_API_KEY=

# After
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. Restart your backend server
The backend needs to reload environment variables.

## Testing the Fix

### 1. Check Backend Health
```bash
curl https://51111279-aedf-4a61-8528-b91efe38deb6-00-1cbwf7ew5dur4.kirk.replit.dev/api/health
```

Look for AI provider status:
```json
{
  "services": {
    "deepseek": true,  // ✅ API key configured
    "groq": false      // ❌ No API key
  }
}
```

### 2. Test AI Endpoint
After adding API keys, test onboarding:

1. Sign up in the app
2. Start onboarding flow
3. Type: "I want to earn money"
4. Should receive AI response (not error)

## Error Messages Guide

| Error | Cause | Solution |
|-------|-------|----------|
| "Load failed" | Cannot connect to backend | Check backend URL & network |
| "Request timeout" | Backend slow/starting | Wait 10-15s, try again |
| "Not authenticated" | No/invalid auth token | Sign in again |
| "Account setup incomplete" | User not in database | Complete signup first |
| "AI service unavailable" | AI provider error | Check API keys |

## Budget Considerations

### Free Options (For Beta)
- **Groq**: Completely free, fast, great for chat
- **Anthropic Claude**: Has free tier

### Low-Cost Options
- **DeepSeek**: ~$0.27 per 1M tokens (very cheap)
- **OpenRouter**: Pay only for what you use

### Enterprise Options
- **OpenAI GPT-4**: Best quality, ~$5-10 per 1M tokens
- Good for production when quality matters

## Current Improvements Made

✅ Added timeout handling to prevent hanging
✅ Improved fallback responses for common queries
✅ Better error messages for debugging
✅ Graceful degradation when no AI configured
✅ Console logging for troubleshooting

## Next Steps

1. **Choose an AI provider** (recommend Groq for free start)
2. **Sign up and get API key**
3. **Add to env.backend file**
4. **Restart backend server**
5. **Test onboarding flow**
6. **Monitor console logs** for any issues

## Support

If you continue to see "Load failed" after adding API keys:

1. Check backend logs in Replit console
2. Verify environment variables loaded: `echo $GROQ_API_KEY`
3. Test health endpoint shows correct status
4. Check network connectivity to backend URL
5. Verify Firebase authentication working

---

**Status**: ✅ Fallback system works without AI
**Recommended**: Add at least Groq API key for full functionality
**Priority**: Medium (can launch with fallback, but AI enhances experience)
