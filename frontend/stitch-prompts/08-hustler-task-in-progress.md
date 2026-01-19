# Screen 8: Hustler Task In-Progress (Hustler View)
## Purpose: Prevent disputes, keep hustler compliant, make system authority visible, create auditable trail

### Stitch Prompt

```
Design a high-fidelity mobile app UI screen for HustleXP, a premium AI-powered gig marketplace.

Screen: Task In Progress (Hustler View)

Style: Apple Glass aesthetic, clean typography, subtle glassmorphism, authoritative and procedural.
Design for iPhone 15 Pro Max viewport (430×932px). Dark mode preferred.

This screen should feel like a mission dashboard, not a chat app.

Visual Requirements:
- Full-screen task execution view
- Clear step-by-step task authority
- Proof requirements visibly enforced
- No distractions, no playful elements

Content Layout (Top to Bottom):

1. STATUS HEADER (Top, fixed)
   - Task state label: "WORKING" (uppercase, size: 12px, tracking: 2px, color: #FF9500, weight: 700)
   - Task title: "Move furniture — 2nd floor walk-up" (size: 20px, weight: 700, color: white)
   - Subtext: "Instant task • Escrow protected" (size: 12px, color: #8E8E93)

2. TIME AUTHORITY BAR
   - Glassmorphic card (background: rgba(28, 28, 30, 0.6), blur)
   - Remaining time: "Time remaining: 42 min" (size: 16px, weight: 600, color: white)
   - Subtext: "Late completion may affect XP" (size: 12px, color: #FF9500)
   - Horizontal progress bar showing elapsed vs expected time
   - Progress bar: Full width, height: 4px, background: rgba(255, 255, 255, 0.1), filled portion: #FF9500, rounded

3. TASK CHECKLIST (Primary Focus)
   - Header: "Required Steps" (size: 10px, uppercase, tracking: 2px, color: #8E8E93, weight: 700)
   - Vertical step line connecting all steps (dark gray, 2px width)
   - Checklist items (each with status icon, vertical spacing: 32px, relative positioning):
   
   Step 1 (Completed):
   - Green checkmark circle (filled, size: 24px)
   - "Accept Mission" (size: 16px, color: #8E8E93, line-through, weight: 500)
   
   Step 2 (Completed):
   - Green checkmark circle (filled, size: 24px)
   - "Arrive at Location" (size: 16px, color: #8E8E93, line-through, weight: 500)
   - GPS verification: "📍 GPS Verified: 10:48 AM" (size: 11px, color: #6B7280, monospace, margin-top: 4px)
   
   Step 3 (Active, Required):
   - Amber radio button (filled, size: 24px, with subtle glow shadow)
   - "Upload in-progress proof" (size: 18px, color: white, weight: 700, leading-tight)
   - "Action required" (size: 12px, color: #FF9500, weight: 500, with pulsing dot indicator)
   
   Step 4 (Pending):
   - Gray radio button (unchecked, size: 24px)
   - "Submit Final Report" (size: 16px, color: #6B7280, weight: 500)

4. PROOF UPLOAD MODULE (Locked Focus)
   - Highlighted glass card with border accent (border: 2px solid #FF9500, background: rgba(255, 149, 0, 0.1), subtle gradient glow)
   - Padding: 20px
   - Header: "In-Progress Proof Required" (size: 18px, weight: 700, color: white)
   - Contract ID: "#820-A4" (size: 10px, color: #8E8E93, uppercase, monospace, tracking: 1px)
   - Proof requirement badges (4 badges, flex-wrap):
     * "📍 On-site only" (gray background, white border)
     * "⏱ During work window" (gray background, white border)
     * "📸 Rear camera" (gray background, white border)
     * "🔒 Verified" (amber background, amber border, emphasized)
   - Divider: subtle gradient line
   - "WHAT MUST BE VISIBLE" section:
     * Heading: uppercase, size: 10px, tracking: 1.5px, color: #8E8E93
     * Checklist with green checkmarks:
       - "Entry point of the site"
       - "Active work area"
       - "Equipment or materials in use"
   - "RULES" section:
     * Heading: uppercase, size: 10px, tracking: 1.5px, color: #8E8E93
     * Text: "Wide-angle photo • No filters or edits • Taken on-site (GPS verified)" (size: 14px, color: #E5E5EA)
   - Warning box: dark background, amber warning icon, text: "Missing or unclear proof may delay completion or affect XP." (size: 12px, color: #8E8E93)
   - Button: "Capture Required Photo" (full-width, height: 48px, rounded: 12px, background: #007AFF, color: white, weight: 700, size: 14px, camera icon on left)

5. TASK DETAILS (Secondary)
   - Grid layout: 3 columns, equal width
   - Glass cards (background: rgba(28, 28, 30, 0.6), blur, border: rgba(255, 255, 255, 0.05))
   - Each card: centered content, icon at top, label below, value below label
   - Card height: 96px
   - Padding: 12px
   
   Card 1 — LOCATION:
   - Icon: location_on (size: 20px, color: #8E8E93)
   - Label: "LOCATION" (size: 9px, uppercase, tracking: 1.2px, color: #8E8E93, weight: 700)
   - Value: "On-site" (size: 14px, color: white, weight: 600)
   
   Card 2 — RISK:
   - Icon: shield_moon (size: 20px, color: #8E8E93)
   - Label: "RISK" (size: 9px, uppercase, tracking: 1.2px, color: #8E8E93, weight: 700)
   - Value: "Low" (size: 14px, color: #34C759, weight: 600)
   
   Card 3 — TIER:
   - Icon: workspace_premium (size: 20px, color: #8E8E93)
   - Label: "TIER" (size: 9px, uppercase, tracking: 1.2px, color: #8E8E93, weight: 700)
   - Value: "Gold" (size: 14px, color: #FFD700, weight: 600)

6. SUPPORT & SAFETY (Bottom, subdued)
   - Text button: "Report an issue" (size: 14px, color: #8E8E93, weight: 500)
   - Subtext: "Use only if task cannot be completed as described" (size: 12px, color: #8E8E93, opacity: 0.7)

Spacing:
- Card spacing: 16px vertical
- Card padding: 20px
- Section spacing: 24px

Typography:
- Font family: SF Pro Display
- Headers: weight 700
- Labels: weight 600
- Body: weight 400

Color Palette:
- Background: #000000
- Card background: rgba(28, 28, 30, 0.6) with blur
- Primary action: #007AFF (blue)
- Warning/Time: #FF9500 (amber)
- Success: #34C759 (green)
- Text primary: #FFFFFF
- Text secondary: #8E8E93

Tone:
Procedural. Calm. Authoritative.
The system is in control, not the hustler.

Constraints:
- Static UI only. No animations.
- No chat-first UI.
- No ability to bypass proof requirements.
- Proof upload is the visual focal point.
- No playful elements or gamification.
- Mission dashboard aesthetic, not social app.
```

### Design Notes

**Why this matters:**
- Prevents disputes before they happen
- Keeps hustler focused and compliant
- Makes system authority visible
- Creates auditable execution trail

**Visual Authority:**
- Proof requirements are unavoidable (highlighted card, border accent)
- Time authority is visible (progress bar, warning text)
- Checklist enforces step-by-step compliance
- No chat affordances = no negotiation
- System is in control, not the hustler

**Trust Signals:**
- Escrow protection mentioned
- Risk level visible
- Trust tier enforcement visible
- Proof is time-stamped and reviewed automatically
- Poster verified badge

**Behavioral Rules (Enforced by UI):**
- ❌ Cannot mark complete without required proof (UI blocks)
- ❌ Cannot skip steps (checklist is sequential)
- ❌ Cannot "message instead of complying" (no chat UI)
- ❌ Cannot ignore time pressure (progress bar + warning)

**Backend States Represented:**
- `EN_ROUTE` / `WORKING` states
- `proof_missing` / `proof_rejected` signals
- `late_warning` / `time_remaining` authority
- `risk_level` / `trust_tier_required` visibility
- `instant_mode` / `sensitive` flags

**Adversarial Test:**
- Bad actor cannot "fake" completion (proof required, time-stamped)
- Confused user knows exactly what to do (clear checklist, one primary action)
- Dispute reviewer can reconstruct intent (auditable trail, proof timestamps)

---
