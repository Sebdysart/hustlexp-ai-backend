# ✅ Ralph Wiggum Installation Complete

## Installation Status

### ✅ Prerequisites Met
- **cursor-agent CLI**: Installed at `~/.local/bin/cursor-agent` (version: 2026.01.09-231024f)
- **Git repository**: Confirmed
- **Ralph scripts**: All installed in `.cursor/ralph-scripts/`

### ✅ Installed Components
```
.cursor/ralph-scripts/
├── ralph-common.sh      (22KB) - Common utilities
├── ralph-setup.sh       (12KB) - Interactive setup
├── ralph-loop.sh        (5KB)  - Main looping script
├── ralph-once.sh        (7KB)  - Single iteration test
└── stream-parser.sh     (10KB) - Stream parsing

.ralph/
├── activity.log         - Real-time progress tracking
├── implementation-summary.md
└── README.md

RALPH_TASK.md            - Task definition with success criteria
.cursorrules             - Governance constraints (will be respected)
```

## Quick Start

### Option 1: CLI Mode (Recommended for Non-Interactive)
```bash
# Make sure cursor-agent is in PATH
export PATH="$HOME/.local/bin:$PATH"

# Run Ralph loop (30 iterations, on current branch)
./.cursor/ralph-scripts/ralph-loop.sh -n 30 -m claude-opus-4.5 -y

# Or specify a branch
./.cursor/ralph-scripts/ralph-loop.sh -n 30 -m claude-opus-4.5 --branch stripe-implementation -y
```

### Option 2: Interactive Setup (Requires gum)
```bash
# Install gum first (optional but provides better UI)
brew install gum

# Run interactive setup
./.cursor/ralph-scripts/ralph-setup.sh
```

### Option 3: Single Test Run
```bash
# Test one iteration to verify setup
./.cursor/ralph-scripts/ralph-once.sh
```

## Monitoring

### Watch Progress
```bash
# Real-time activity log
tail -f .ralph/activity.log

# Check for errors
cat .ralph/errors.log
```

### Check Task Status
```bash
# View current task definition
cat RALPH_TASK.md

# Check which checkboxes are complete
grep -E "^\s*- \[" RALPH_TASK.md
```

## How It Works

1. **Reads `RALPH_TASK.md`** - Task definition with checkboxes
2. **Runs `cursor-agent`** - Uses Cursor's agent system
3. **Respects `.cursorrules`** - Governance constraints enforced
4. **Tracks progress** - Updates checkboxes as tasks complete
5. **Rotates context** - At ~80k tokens to prevent overflow
6. **Commits to Git** - Saves progress periodically
7. **Stops when done** - All checkboxes checked OR max iterations reached

## Current Task

The `RALPH_TASK.md` file is configured for:
- **Task**: Complete Stripe Webhook Implementation (Step 9-D)
- **Test Command**: `npm run test:invariants -- stripe-monetization`
- **Max Iterations**: 50

**Note**: This task is currently in skeleton state (rolled back per governance). 
Ralph will implement exactly to the invariants when you run it.

## Important Notes

1. **Governance**: Ralph will respect `.cursorrules` - no unauthorized implementation
2. **Phase Gates**: Will stop and ask for approval before implementing payments/Stripe logic
3. **Branch Safety**: All work happens on branches (never directly on main)
4. **Cost Tracking**: Monitor `.ralph/activity.log` for token usage
5. **Context Rotation**: Automatically handles large codebases

## Troubleshooting

### cursor-agent not found
```bash
export PATH="$HOME/.local/bin:$PATH"
# Or add to ~/.zshrc:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Scripts not executable
```bash
chmod +x .cursor/ralph-scripts/*.sh
```

### Need to update task
Edit `RALPH_TASK.md` - Ralph will pick up changes on next run.

## Next Steps

1. **Review `RALPH_TASK.md`** - Ensure task definition is correct
2. **Choose a branch** - Decide where Ralph should work
3. **Run Ralph** - Start the loop with your preferred method
4. **Monitor progress** - Watch `.ralph/activity.log`

Ralph is ready to use! 🎉
