# Filesystem MCP Server - Documentation Access Setup

> **Status**: ✅ Fixed - Using Official Filesystem MCP  
> **Purpose**: Enable direct access to HustleXP documentation via filesystem MCP

## Overview

**Filesystem MCP Server** (official Model Context Protocol server) provides direct file access to your project documentation. It allows agents to read exact information from Markdown files in the HustleXP docs directory.

**Why Filesystem MCP Instead of GroundX**:
- ✅ Official MCP server (verified package)
- ✅ No API key required
- ✅ Direct file access
- ✅ Fast and reliable
- ❌ GroundX MCP package doesn't exist in npm registry

---

## Configuration

### MCP Configuration

The Filesystem MCP server is configured in `~/.cursor/mcp.json`:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem@latest", "/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS"]
  }
}
```

**Key Settings**:
- **Command**: `npx` (auto-installs package)
- **Package**: `@modelcontextprotocol/server-filesystem@latest` (official MCP server)
- **Directory**: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS` (HustleXP docs path)

---

## Available Tools

Filesystem MCP provides these tools:

### 1. `read_file`
Read a specific file from the docs directory.

**Example**:
```
"Read PRODUCT_SPEC.md from HustleXP docs"
```

### 2. `list_directory`
List files and directories.

**Example**:
```
"List all files in HustleXP docs directory"
```

### 3. `search_files`
Search for files by name pattern.

**Example**:
```
"Search for files containing 'ARCHITECTURE' in HustleXP docs"
```

### 4. `write_file` (if needed)
Write files (use with caution).

---

## Usage Examples

### Example 1: Read Specific Doc

```
"Read PRODUCT_SPEC.md and tell me what it says about task pricing"
```

**How it works**:
1. Filesystem MCP reads `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/PRODUCT_SPEC.md`
2. Returns exact file content
3. Agent searches for "task pricing" section
4. Returns exact spec requirements

### Example 2: Verify Architecture Compliance

```
"Read ARCHITECTURE.md and check if this service follows Layer 1 pattern"
```

**How it works**:
1. Filesystem MCP reads `ARCHITECTURE.md`
2. Agent extracts Layer 1 requirements
3. Compares with implementation
4. Reports exact compliance status

### Example 3: Find All References

```
"Read all HustleXP docs and find all mentions of 'INV-1'"
```

**How it works**:
1. Filesystem MCP lists all `.md` files
2. Agent reads each file
3. Searches for "INV-1" mentions
4. Returns exact contexts

### Example 4: Check Schema Alignment

```
"Read schema.sql from HustleXP docs and compare with backend/database/constitutional-schema.sql"
```

**How it works**:
1. Filesystem MCP reads both files
2. Agent compares schemas
3. Reports differences
4. Suggests fixes

---

## Workflow for Agent Coordination

### When Reviewing Agent Output

1. **Query HustleXP Docs** (using filesystem MCP):
   ```
   "Read PRODUCT_SPEC.md and verify this feature matches §3.2 requirements"
   ```

2. **Get Exact Spec**:
   - Filesystem MCP reads the file
   - Returns exact text
   - Agent compares with implementation

3. **Report Alignment**:
   - Exact matches identified
   - Missing requirements listed
   - Suggested fixes provided

### When Agents Work on Code

1. **Agent Queries Specs** (using filesystem MCP):
   ```
   "Read ARCHITECTURE.md and tell me Layer 1 requirements for services"
   ```

2. **Agent Gets Exact Requirements**:
   - Filesystem MCP reads ARCHITECTURE.md
   - Returns exact Layer 1 text
   - Agent implements exactly as specified

3. **Agent Verifies Before Submitting**:
   ```
   "Read AI_INFRASTRUCTURE.md and verify my AI function respects A2 authority"
   ```

---

## Advantages

### ✅ Direct File Access
- No API calls needed
- Fast local file reading
- No rate limits

### ✅ Exact References
- Returns actual file content
- No interpretation needed
- Real spec quotes

### ✅ Reliable
- Official MCP server package
- No external dependencies
- Works offline

### ✅ Simple Setup
- No API keys required
- Just specify directory path
- Works immediately

---

## Limitations

### ❌ No Advanced RAG
- Basic file reading only
- No semantic search
- No cross-file queries

### ❌ Manual Search
- Agent must read files first
- Then search within content
- No automatic indexing

### 💡 Workaround
- Use GitHub MCP for remote docs
- Combine with codebase search
- Agent can search file contents after reading

---

## Alternative: GitHub MCP for Remote Docs

If HustleXP docs are on GitHub, use GitHub MCP:

**Configuration**:
```json
{
  "github-mcp": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github@latest"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"
    }
  }
}
```

**Usage**:
```
"Read PRODUCT_SPEC.md from HustleXP/docs repository"
```

---

## Troubleshooting

### Issue: Filesystem MCP Not Reading Files

**Solution**:
1. Verify directory path is correct
2. Check file permissions
3. Ensure files exist at path
4. Restart Cursor after config changes

### Issue: Access Denied

**Solution**:
1. Check file permissions
2. Ensure directory is readable
3. Verify path is correct

### Issue: Files Not Found

**Solution**:
1. Verify path: `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS`
2. List directory to see available files
3. Check file names match (case-sensitive)

---

## Next Steps

1. ✅ **Filesystem MCP Configured** - Ready to use
2. ⏳ **Restart Cursor** - Load new configuration
3. ⏳ **Test File Access** - Try reading PRODUCT_SPEC.md
4. ⏳ **Start Using for Reviews** - Query docs when reviewing agent output

---

## Summary

With **Filesystem MCP Server** configured, we can now:

✅ **Read HustleXP Docs Directly** - Access files from `/Users/sebastiandysart/HustleXP/HUSTLEXP-DOCS/`  
✅ **Get Exact Spec References** - Real file content, not interpretations  
✅ **Verify Alignment** - Compare implementations with exact spec text  
✅ **Prevent Hallucinations** - Use real documentation, not made-up specs  

**Status**: ✅ **FIXED - READY FOR DOCUMENTATION ACCESS**

All agents can now access HustleXP documentation directly using the filesystem MCP server!
