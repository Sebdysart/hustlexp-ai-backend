# Mobile MCP Setup Guide for Cursor

> **Status**: Setup Guide for AI Agent Coordination  
> **Purpose**: Enable AI agents to interact directly with iOS/Android devices for testing and automation

## Overview

Mobile Next (Mobile MCP) is an open-source Model Context Protocol server that enables AI agents in Cursor to:
- Interact with iOS simulators and Android emulators
- Take screenshots and analyze UI using accessibility snapshots
- Automate testing and UI interactions
- Debug apps in real-time
- Extract data from native apps

---

## Prerequisites

Before setting up Mobile MCP, ensure you have:

- ✅ **Node.js** installed (current version for `npx` to work)
- ✅ **Android Emulator** (via ADB) or **iOS Simulator** (via Xcode)
- ✅ **Cursor** with MCP support
- ✅ Device/emulator running and detected by system

---

## Installation Steps (2026)

### Step 1: Open MCP Settings in Cursor

1. **Launch Cursor**
2. **Open Settings**:
   - Click the gear icon (⚙️) in the top-right corner
   - Or press `Cmd + ,` (Mac) / `Ctrl + ,` (Windows)
3. **Navigate to MCP**:
   - Go to **Cursor Settings > Features** (or **Tools & Integrations**)
   - Select **MCP** section from the sidebar

### Step 2: Add the Mobile MCP Server

1. **Click** `+ Add New MCP Server` button
2. **Configure the server**:
   - **Name**: `mobile-mcp` (or any name you prefer)
   - **Type**: Select `command` (or `stdio`)
   - **Command**: `npx`
   - **Arguments**: Copy and paste exactly:
     ```json
     ["-y", "@mobilenext/mobile-mcp@latest"]
     ```
3. **Save** the configuration

### Step 3: Verify Connection

1. **Check Status**: Look for a **green indicator** next to the server name in settings (confirms it's active)
2. **Test Connection**:
   - Open a new chat in **Composer** or **Agent** mode
   - Ask: `"What mobile devices are connected?"`
   - Cursor should be able to access the tool and list available devices

---

## Prerequisites Setup

### For iOS Simulator (macOS)

1. **Install Xcode** (if not already installed):
   ```bash
   xcode-select --install
   ```

2. **Launch iOS Simulator**:
   ```bash
   open -a Simulator
   ```
   
   Or via Xcode:
   - Open Xcode
   - Go to **Xcode > Open Developer Tool > Simulator**

3. **Verify Simulator is Running**:
   - Simulator window should be visible
   - Device should be listed in Cursor when you ask about devices

### For Android Emulator

1. **Install Android Studio** (if not already installed)
2. **Set up Android SDK** and emulator
3. **Launch Android Emulator**:
   ```bash
   emulator -avd <your_avd_name>
   ```
   
   Or via Android Studio:
   - Open Android Studio
   - Go to **Tools > Device Manager**
   - Click the play button on an emulator

4. **Verify ADB Connection**:
   ```bash
   adb devices
   ```
   Should list your emulator

---

## Usage Examples

Once Mobile MCP is set up, agents can:

### Example 1: List Available Devices
```
"What mobile devices are connected?"
```
→ Agent lists iOS simulators and Android emulators

### Example 2: Take Screenshot
```
"Take a screenshot of the iOS simulator"
```
→ Agent captures current screen

### Example 3: Visual Verification
```
"Add a blue circle view and verify it renders correctly by taking a screenshot"
```
→ Agent:
1. Writes the code
2. Takes screenshot
3. Verifies UI is correct

### Example 4: Interactive Testing
```
"Add a counter button that increments on tap. 
Then test it by tapping it 3 times and verify the count is 3"
```
→ Agent:
1. Implements counter
2. Taps button 3 times
3. Takes screenshot
4. Verifies count is 3

### Example 5: End-to-End Testing
```
"Test the login flow:
1. Open the app
2. Enter email 'test@example.com'
3. Enter password 'password123'
4. Tap login button
5. Take a screenshot and verify we're on the home screen"
```
→ Agent tests complete flow automatically

---

## Troubleshooting

### Issue: Green Indicator Not Showing

**Possible Causes**:
- Node.js not installed or not in PATH
- `npx` command not working
- MCP server failed to start

**Solutions**:
```bash
# Verify Node.js is installed
node --version

# Verify npx works
npx --version

# Try running manually
npx -y @mobilenext/mobile-mcp@latest
```

### Issue: "No devices found"

**Possible Causes**:
- Simulator/Emulator not running
- Device not detected by system

**Solutions**:
- **iOS**: Ensure Simulator is running (`open -a Simulator`)
- **Android**: Check `adb devices` lists your emulator
- Restart Cursor after launching device

### Issue: Screenshots Not Working

**Possible Causes**:
- App not running on device
- Permissions not granted
- Device not in foreground

**Solutions**:
- Ensure app is built and running on device
- Check simulator/emulator is visible and active
- Try manually taking a screenshot first

---

## Configuration Summary

**For Cursor MCP Settings**:

```json
{
  "name": "mobile-mcp",
  "type": "command",
  "command": "npx",
  "arguments": ["-y", "@mobilenext/mobile-mcp@latest"]
}
```

**Quick Test Command**:
```
"What mobile devices are connected?"
```

---

## Integration with Agent Coordination

### For iOS App Development Agents

When working on the iOS app, agents can now:

1. **Visual Verification**
   - Screenshot and verify UI implementations
   - Check layouts match designs
   - Verify animations work

2. **Automated Testing**
   - Test user flows end-to-end
   - Verify interactions work correctly
   - Catch UI bugs automatically

3. **Real-time Debugging**
   - See app state in real-time
   - Debug issues as they happen
   - Fix and verify immediately

4. **Feature Exploration**
   - Understand app structure visually
   - Document screens and flows
   - Identify missing features

---

## References

- [Mobile MCP GitHub](https://github.com/mobile-next/mobile-mcp)
- [Cursor MCP Setup Guide](https://github.com/mobile-next/mobile-mcp/wiki/Getting-Started-with-Cursor)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

## Quick Start Checklist

- [ ] Node.js installed and working
- [ ] iOS Simulator or Android Emulator installed
- [ ] Device/Emulator launched and running
- [ ] Cursor MCP settings configured
- [ ] Green indicator showing in Cursor settings
- [ ] Test query: "What mobile devices are connected?" works

---

**Status**: ✅ Documentation complete. Follow the steps above to set up Mobile MCP in Cursor.

Once configured, agents will have powerful mobile automation capabilities for testing and debugging the iOS app!
