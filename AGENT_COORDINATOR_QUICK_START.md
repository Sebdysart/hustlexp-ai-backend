# Agent Coordinator - Quick Start Guide

## 🎯 Your Role

You are the **Agent Coordinator** for the HustleXP iOS app development. Your job is to:
1. Review agent outputs
2. Provide guidance and feedback
3. Ensure consistency across all agent work
4. Keep agents aligned with backend integration

## 📋 How to Use This System

### When an Agent Submits Output

1. **Read the output** - Understand what the agent has created/modified

2. **Verify HustleXP Docs Alignment** ⭐ **CRITICAL FIRST STEP**
   - Check alignment with `PRODUCT_SPEC.md`
   - Verify `ARCHITECTURE.md` compliance (Layer model)
   - Validate `AI_INFRASTRUCTURE.md` authority (if AI-related)
   - Confirm `schema.sql` compliance (if DB-related)
   - Use MCP to access docs directly: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`

3. **Review against guidelines** - Check `AGENT_COORDINATION.md` for standards:
   - Backend integration (correct API endpoints)
   - Error handling (HX error codes)
   - Code quality
   - Architecture patterns (Layer 0-3 compliance)

3. **Use the reviewer tool** (optional):
   ```bash
   tsx scripts/agent-output-reviewer.ts <agent-id> <output-file>
   ```

4. **Provide feedback** - Give clear, actionable guidance:
   - ✅ What's good
   - ⚠️  What needs improvement
   - 🚨 Blockers that must be fixed
   - 📚 Point to relevant documentation

5. **Update tracking** - Log in `AGENT_COORDINATION.md`:
   - Add agent to tracking table
   - Update status
   - Note any dependencies

### Accessing GitHub Docs

To fetch the latest HustleXP documentation:

```bash
# Set your GitHub token
export GITHUB_TOKEN=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

# List available docs
tsx scripts/fetch-github-docs.ts

# Fetch specific doc
tsx scripts/fetch-github-docs.ts docs/README.md
```

## 🔑 Key Resources

### HustleXP Constitutional Documentation ⭐ **HIGHEST PRIORITY**
**Location**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`

**MCP-Enabled Access**: Agents can now read these docs directly via MCP!

**Core Documents** (Always verify against these):
- `PRODUCT_SPEC.md` - Product requirements, features
- `ARCHITECTURE.md` - System architecture, layers, invariants
- `AI_INFRASTRUCTURE.md` - AI authority model (A0-A3)
- `schema.sql` - Database schema (Layer 0, highest authority)

**Before approving ANY agent work**, verify alignment with these docs!

### Backend Integration
- **URL**: `https://hustlexp-ai-backend-production.up.railway.app`
- **API Docs**: `docs/IOS_TRPC_INTEGRATION.md` (NEW - tRPC)
- **AI Endpoint**: `POST /ai/orchestrate`

### Important Files
- `AGENT_COORDINATION.md` - Main coordination hub
- `docs/HUSTLEXP_DOCS_ALIGNMENT.md` - **NEW: Documentation alignment workflow**
- `docs/IOS_TRPC_INTEGRATION.md` - Complete tRPC API reference
- `BACKEND_AUDIT.md` - Backend capabilities
- `AI_ORCHESTRATION_COMPLETE.md` - AI integration guide

## 📝 Example Review Response

When reviewing agent output, structure your response like this:

```
## Review of Agent [ID] Output

### ✅ Strengths
- Proper backend integration with correct endpoints
- Good error handling implementation
- Clean code structure

### ⚠️  Areas for Improvement
- Missing loading states for async operations
- Consider adding more documentation

### 🚨 Blockers
- [None / List any critical issues]

### 📚 References
- See `docs/FRONTEND_INTEGRATION.md` for API details
- Check `AI_ORCHESTRATION_COMPLETE.md` for AI integration patterns

### ✅ Status: Approved / Needs Revision
```

## 🎯 Common Scenarios

### Agent doesn't know API structure
→ Direct them to `docs/FRONTEND_INTEGRATION.md`

### Agent creates duplicate code
→ Check agent tracking table, redirect to existing work

### Agent uses wrong patterns
→ Provide examples from existing codebase or docs

### Agent needs backend info
→ Use `fetch-github-docs.ts` to get latest docs

## 🚀 Ready to Start

You're all set! When an agent submits their output, paste it here and I'll help you review and provide guidance.

---

**Remember**: Your goal is to keep all agents aligned, consistent, and moving toward a cohesive iOS app that properly integrates with the backend.
