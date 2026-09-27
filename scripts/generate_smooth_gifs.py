#!/usr/bin/env python3
"""
scripts/generate_smooth_gifs.py
Generates ultra-smooth, realistic, non-robotic terminal recording GIFs
for RailFog v0.9.2 Four-Primitives CLI experience.
"""

import os
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont

WIDTH = 900
HEIGHT = 520
BG_COLOR = (30, 30, 46)        # Catppuccin Mocha Base
TITLE_BG = (17, 17, 27)        # Catppuccin Mocha Crust
BORDER_COLOR = (49, 50, 68)    # Surface0
TEXT_COLOR = (205, 214, 244)   # Text
PROMPT_COLOR = (137, 180, 250) # Blue
CMD_COLOR = (166, 227, 161)    # Green
CYAN_COLOR = (137, 220, 235)   # Cyan
MAGENTA_COLOR = (203, 166, 247)# Mauve
YELLOW_COLOR = (249, 226, 175) # Yellow
PEACH_COLOR = (250, 179, 135)  # Peach
DIM_COLOR = (108, 112, 134)    # Overlay0
GREEN_BOLD = (166, 227, 161)   # Green

FONT_MAIN = ImageFont.truetype("consola.ttf", 15)
FONT_BOLD = ImageFont.truetype("consolab.ttf", 15)
FONT_TITLE = ImageFont.truetype("arial.ttf", 13)

LINE_HEIGHT = 22
PADDING_LEFT = 24
PADDING_TOP = 56

def create_base_window(title_text="railfog v0.9.2"):
    img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Window body
    draw.rounded_rectangle([(0, 0), (WIDTH - 1, HEIGHT - 1)], radius=10, fill=BG_COLOR, outline=BORDER_COLOR, width=1)

    # Title bar
    draw.rounded_rectangle([(0, 0), (WIDTH - 1, 38)], radius=10, fill=TITLE_BG)
    draw.rectangle([(0, 28), (WIDTH - 1, 38)], fill=TITLE_BG)
    draw.line([(0, 38), (WIDTH - 1, 38)], fill=BORDER_COLOR, width=1)

    # Window controls (macOS / Linux style dots)
    draw.ellipse([(14, 13), (26, 25)], fill=(243, 139, 168)) # Red
    draw.ellipse([(34, 13), (46, 25)], fill=(249, 226, 175)) # Yellow
    draw.ellipse([(54, 13), (66, 25)], fill=(166, 227, 161)) # Green

    # Title text
    bbox = draw.textbbox((0, 0), title_text, font=FONT_TITLE)
    tw = bbox[2] - bbox[0]
    draw.text(((WIDTH - tw) // 2, 11), title_text, fill=(166, 173, 200), font=FONT_TITLE)

    return img

def render_frame(lines, cursor_pos=None, cursor_visible=True, title="railfog — v0.9.2"):
    """
    lines: list of list of (text, color, is_bold)
    cursor_pos: (line_idx, col_idx) or None
    """
    img = create_base_window(title)
    draw = ImageDraw.Draw(img)

    y = PADDING_TOP
    for l_idx, line in enumerate(lines):
        x = PADDING_LEFT
        char_count = 0
        for seg in line:
            if isinstance(seg, str):
                text = seg
                color = TEXT_COLOR
                bold = False
            else:
                text = seg[0] if len(seg) > 0 else ""
                color = seg[1] if len(seg) > 1 else TEXT_COLOR
                bold = seg[2] if len(seg) > 2 else False

            if not text:
                continue

            font = FONT_BOLD if bold else FONT_MAIN

            draw.text((x, y), text, fill=color, font=font)
            seg_w = draw.textlength(text, font=font)

            if cursor_pos and cursor_pos[0] == l_idx and cursor_visible:
                c_col = cursor_pos[1]
                if char_count <= c_col <= char_count + len(text):
                    cursor_x = x + draw.textlength(text[:c_col - char_count], font=font)
                    draw.rectangle([(cursor_x, y + 2), (cursor_x + 9, y + 18)], fill=TEXT_COLOR)

            char_count += len(text)
            x += seg_w

        # If cursor is at the end of the line
        if cursor_pos and cursor_pos[0] == l_idx and cursor_visible and cursor_pos[1] >= char_count:
            draw.rectangle([(x, y + 2), (x + 9, y + 18)], fill=TEXT_COLOR)

        y += LINE_HEIGHT

    return img

def build_gif_from_frames(frames, output_path, fps=10):
    os.makedirs("scratch_frames", exist_ok=True)
    temp_paths = []
    try:
        for idx, f in enumerate(frames):
            p = f"scratch_frames/f_{idx:04d}.png"
            f.save(p)
            temp_paths.append(p)

        cmd = [
            "C:/Users/Forke/scoop/shims/ffmpeg.exe",
            "-y",
            "-framerate", str(fps),
            "-i", "scratch_frames/f_%04d.png",
            "-vf", "split[s0][s1];[s0]palettegen=stats_mode=diff:max_colors=128[p];[s1][p]paletteuse=dither=bayer",
            output_path
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            print(f"[+] Rendered smooth GIF ({len(frames)} frames @ {fps}fps): {output_path}")
        else:
            print(f"[-] ffmpeg error: {res.stderr}")
    finally:
        shutil.rmtree("scratch_frames", ignore_errors=True)

# =============================================================================
# SCENARIO 1: Flagship Demo (rail init -> rail check -> rail dev)
# =============================================================================
def generate_demo_gif():
    frames = []
    fps = 10

    # 1. Idle prompt (4 frames)
    for i in range(4):
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True)]],
            cursor_pos=(0, 14),
            cursor_visible=(i % 4 < 2),
            title="railfog — flagship developer experience — v0.9.2"
        ))

    # 2. Type "rail init upload-pipeline --template worked-example"
    cmd = "rail init upload-pipeline --template worked-example"
    current_cmd = ""
    for char in cmd:
        current_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True), (current_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 14 + len(current_cmd)),
            cursor_visible=True,
            title="railfog — flagship developer experience — v0.9.2"
        ))

    # Pause after typing before enter (3 frames)
    for i in range(3):
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 14 + len(cmd)),
            cursor_visible=True,
            title="railfog — flagship developer experience — v0.9.2"
        ))

    # 3. Spinner / execution (4 frames)
    spinners = ["⠋", "⠙", "⠹", "⠸"]
    for s in spinners:
        frames.append(render_frame([
            [("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
            [(f"  {s} Scaffolding Four-Primitives station ticket...", CYAN_COLOR, False)],
        ], cursor_pos=None, title="railfog — flagship developer experience — v0.9.2"))

    # 4. Station Ticket appears
    ticket_lines = [
        [("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("┌── RailFog Station Ticket: Project Scaffolded ──────────────────────────┐", DIM_COLOR, False)],
        [("│  Station:    ", CYAN_COLOR, True), ("upload-pipeline", MAGENTA_COLOR, False), ("                                     │", DIM_COLOR, False)],
        [("│  Template:   ", CYAN_COLOR, True), ("Worked Example (Compute + State + Data + Signal)         │", TEXT_COLOR, False)],
        [("│  Platform:   ", CYAN_COLOR, True), ("Deno LTS • V8 Isolates • Zero Ambient Authority          │", TEXT_COLOR, False)],
        [("│  Created:    ", CYAN_COLOR, True), ("railfog.toml, functions/api.ts, processor.ts, deno.json   │", DIM_COLOR, False)],
        [("│  Status:     ", CYAN_COLOR, True), ("[+] Initialized successfully", GREEN_BOLD, True), ("                          │", DIM_COLOR, False)],
        [("└────────────────────────────────────────────────────────────────────────┘", DIM_COLOR, False)],
    ]
    for _ in range(6):
        frames.append(render_frame(ticket_lines, title="railfog — flagship developer experience — v0.9.2"))

    # 5. Type "cd upload-pipeline && rail check"
    next_cmd = "cd upload-pipeline && rail check"
    typed_next = ""
    for char in next_cmd:
        typed_next += char
        cur_lines = ticket_lines + [
            [("railfog@v8:~$ ", PROMPT_COLOR, True), (typed_next, CMD_COLOR, False)]
        ]
        frames.append(render_frame(
            cur_lines,
            cursor_pos=(len(cur_lines) - 1, 14 + len(typed_next)),
            cursor_visible=True,
            title="railfog — flagship developer experience — v0.9.2"
        ))

    # 6. Route Specificity table streams in
    check_lines = ticket_lines + [
        [("railfog@v8:~$ ", PROMPT_COLOR, True), (next_cmd, CMD_COLOR, False)],
        [("Route Specificity Summary (PLAT-11):", CYAN_COLOR, True)],
        [("  SCORE  ROUTE PATTERN            FUNCTION       CAPABILITIES", DIM_COLOR, False)],
        [("  -----  -----------------------  -------------  ------------------------", DIM_COLOR, False)],
        [("    2    ", PEACH_COLOR, True), ("/upload                 ", CYAN_COLOR, False), ("api            ", TEXT_COLOR, False), ("[data:uploads, signal:jobs]", DIM_COLOR, False)],
        [("    -    ", PEACH_COLOR, True), ("queue:app:jobs          ", CYAN_COLOR, False), ("processor      ", TEXT_COLOR, False), ("[state:files, data:uploads]", DIM_COLOR, False)],
        [("[+] Configuration valid. Zero errors found. Bindings verified.", GREEN_BOLD, True)],
    ]
    for _ in range(8):
        frames.append(render_frame(check_lines, title="railfog — flagship developer experience — v0.9.2"))

    # 7. Type "rail dev"
    dev_cmd = "rail dev"
    typed_dev = ""
    for char in dev_cmd:
        typed_dev += char
        cur_lines = check_lines + [
            [("railfog@v8:~/upload-pipeline$ ", PROMPT_COLOR, True), (typed_dev, CMD_COLOR, False)]
        ]
        frames.append(render_frame(
            cur_lines,
            cursor_pos=(len(cur_lines) - 1, 31 + len(typed_dev)),
            cursor_visible=True,
            title="railfog — flagship developer experience — v0.9.2"
        ))

    # 8. Server boots and simulated traffic arrives
    final_lines = [
        [("railfog@v8:~/upload-pipeline$ ", PROMPT_COLOR, True), ("rail dev", CMD_COLOR, False)],
        [("⚡ RailFog Local Runtime v0.9.2 listening on http://localhost:8000", CYAN_COLOR, True)],
        [("   ↳ Bound Primitives: State (SQLite V8) • Data (LocalFS) • Signal (FIFO)", DIM_COLOR, False)],
        [("   ↳ Watching /functions for hot-reload", DIM_COLOR, False)],
        [("")],
        [("POST", GREEN_BOLD, True), (" /upload ", CYAN_COLOR, False), ("200 OK (1.1ms)", TEXT_COLOR, False)],
        [("  ↳ c.data.presign: ", CYAN_COLOR, False), ("Generated direct PUT URL for key '7c9e-4a2b'", DIM_COLOR, False)],
        [("  ↳ c.signal.send:  ", CYAN_COLOR, False), ("Enqueued job to 'app:jobs'", DIM_COLOR, False)],
        [("QUEUE", GREEN_BOLD, True), (" app:jobs ", CYAN_COLOR, False), ("ACK (2.3ms)", TEXT_COLOR, False)],
        [("  ↳ ctx.state.get:  ", CYAN_COLOR, False), ("Dedupe check passed (processed: false)", DIM_COLOR, False)],
        [("  ↳ ctx.data.get:   ", CYAN_COLOR, False), ("Streamed payload 1.4 MB", DIM_COLOR, False)],
        [("  ↳ ctx.state.set:  ", CYAN_COLOR, False), ("Updated ['files', '7c9e-4a2b'] status='processed'", DIM_COLOR, False)],
    ]

    # Hold the final result for 35 frames (~3.5 seconds)
    for i in range(35):
        frames.append(render_frame(
            final_lines,
            cursor_pos=(len(final_lines) - 1, 75),
            cursor_visible=(i % 6 < 3),
            title="railfog — flagship developer experience — v0.9.2"
        ))

    build_gif_from_frames(frames, "docs/assets/demo.gif", fps=fps)

# =============================================================================
# SCENARIO 2: Interactive Scaffolding (rail init)
# =============================================================================
def generate_init_gif():
    frames = []
    fps = 10

    # Type "rail init my-service"
    cmd = "rail init my-service"
    cur_cmd = ""
    for char in cmd:
        cur_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cur_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 14 + len(cur_cmd)),
            cursor_visible=True,
            title="railfog init — interactive project scaffolding"
        ))

    for _ in range(3):
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)]],
            title="railfog init — interactive project scaffolding"
        ))

    # Interactive choice 1: Cursor at item 1
    choice_frame_1 = [
        [("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("? Select starter template:", CYAN_COLOR, True)],
        [("❯ 1) Minimal Starter     ", GREEN_BOLD, True), ("- Single HTTP compute function + state", DIM_COLOR, False)],
        [("  2) Worked Example      ", TEXT_COLOR, False), ("- End-to-end Compute, State, Data, Signal", DIM_COLOR, False)],
    ]
    for _ in range(6):
        frames.append(render_frame(choice_frame_1, title="railfog init — interactive project scaffolding"))

    # Down arrow pressed: Cursor moves to item 2
    choice_frame_2 = [
        [("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("? Select starter template:", CYAN_COLOR, True)],
        [("  1) Minimal Starter     ", TEXT_COLOR, False), ("- Single HTTP compute function + state", DIM_COLOR, False)],
        [("❯ 2) Worked Example     ", GREEN_BOLD, True), ("- End-to-end Compute, State, Data, Signal", TEXT_COLOR, False)],
    ]
    for _ in range(8):
        frames.append(render_frame(choice_frame_2, title="railfog init — interactive project scaffolding"))

    # Enter pressed: Render Station Ticket
    ticket_lines = [
        [("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("? Select starter template: ", CYAN_COLOR, True), ("Worked Example", GREEN_BOLD, True)],
        [("┌── RailFog Station Ticket: Project Scaffolded ──────────────────────────────┐", DIM_COLOR, False)],
        [("│                                                                            │", DIM_COLOR, False)],
        [("│        ┌──────┐                                                            │", DIM_COLOR, False)],
        [("│          ████           [+] Project created successfully!                  │", GREEN_BOLD, True)],
        [("│    ┌──────────────┐                                                        │", DIM_COLOR, False)],
        [("│    │████  ██  ████│     Station:     ", CYAN_COLOR, False), ("my-service", MAGENTA_COLOR, True), ("                                    │", DIM_COLOR, False)],
        [("│    │██████████████│     Template:    ", CYAN_COLOR, False), ("Worked Example (Four Primitives)           │", TEXT_COLOR, False)],
        [("│    │██  ██  ██  ██│     Platform:    ", CYAN_COLOR, False), ("Deno LTS • V8 Isolates                     │", TEXT_COLOR, False)],
        [("│    │██  ██  ██  ██│     Primitives:  ", CYAN_COLOR, False), ("Compute • State • Data • Signal            │", TEXT_COLOR, False)],
        [("│   ══════════════════                                                       │", DIM_COLOR, False)],
        [("│  Created files:                                                            │", DIM_COLOR, False)],
        [("│    * railfog.toml, functions/api.ts, functions/processor.ts, deno.json     │", TEXT_COLOR, False)],
        [("└────────────────────────────────────────────────────────────────────────────┘", DIM_COLOR, False)],
        [("")],
        [("Next steps:", GREEN_BOLD, True)],
        [("  cd my-service", CYAN_COLOR, False)],
        [("  rail dev", CYAN_COLOR, False)],
    ]
    for i in range(35):
        frames.append(render_frame(
            ticket_lines,
            cursor_pos=(len(ticket_lines) - 1, 10),
            cursor_visible=(i % 6 < 3),
            title="railfog init — interactive project scaffolding"
        ))

    build_gif_from_frames(frames, "docs/assets/cli-init.gif", fps=fps)

# =============================================================================
# SCENARIO 3: Static Validation (rail check)
# =============================================================================
def generate_check_gif():
    frames = []
    fps = 10

    cmd = "rail check"
    cur_cmd = ""
    for char in cmd:
        cur_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cur_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 27 + len(cur_cmd)),
            cursor_visible=True,
            title="railfog check — static validation & route scoring"
        ))

    for s in ["⠋", "⠙", "⠹", "⠸"]:
        frames.append(render_frame([
            [("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
            [(f"  {s} Parsing railfog.toml and validating function entrypoints...", CYAN_COLOR, False)],
        ], title="railfog check — static validation & route scoring"))

    lines = [
        [("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("Route Specificity Summary (PLAT-11):", CYAN_COLOR, True)],
        [("  SCORE  ROUTE PATTERN                  FUNCTION       CAPABILITIES", DIM_COLOR, False)],
        [("  -----  -----------------------------  -------------  ------------------------------", DIM_COLOR, False)],
        [("    4    ", PEACH_COLOR, True), ("/api/v1/users/:id/avatar      ", CYAN_COLOR, False), ("avatarHandler  ", TEXT_COLOR, False), ("[data:avatars, state:users]", DIM_COLOR, False)],
        [("    3    ", PEACH_COLOR, True), ("/api/v1/users/*               ", CYAN_COLOR, False), ("userRouter     ", TEXT_COLOR, False), ("[state:users]", DIM_COLOR, False)],
        [("    2    ", PEACH_COLOR, True), ("/upload                       ", CYAN_COLOR, False), ("api            ", TEXT_COLOR, False), ("[data:uploads, signal:jobs]", DIM_COLOR, False)],
        [("    1    ", PEACH_COLOR, True), ("/*                            ", CYAN_COLOR, False), ("gateway        ", TEXT_COLOR, False), ("[network:allow]", DIM_COLOR, False)],
        [("    -    ", PEACH_COLOR, True), ("queue:app:jobs                ", CYAN_COLOR, False), ("processor      ", TEXT_COLOR, False), ("[state:files, data:uploads]", DIM_COLOR, False)],
        [("")],
        [("[+] Configuration valid. Zero errors found.", GREEN_BOLD, True)],
        [("    Zero ambient authority: All function permissions scoped at deploy time (PLAT-6).", DIM_COLOR, False)],
    ]

    for i in range(35):
        frames.append(render_frame(
            lines,
            cursor_pos=(len(lines) - 1, 85),
            cursor_visible=(i % 6 < 3),
            title="railfog check — static validation & route scoring"
        ))

    build_gif_from_frames(frames, "docs/assets/cli-check.gif", fps=fps)

# =============================================================================
# SCENARIO 4: Local Dev Server (rail dev)
# =============================================================================
def generate_dev_gif():
    frames = []
    fps = 10

    cmd = "rail dev"
    cur_cmd = ""
    for char in cmd:
        cur_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cur_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 27 + len(cur_cmd)),
            cursor_visible=True,
            title="railfog dev — local parity development server"
        ))

    # Boot phase
    boot_lines = [
        [("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("⚡ RailFog Local Runtime v0.9.2 listening on http://localhost:8000", CYAN_COLOR, True)],
        [("   ↳ Hot-reload active for /functions", DIM_COLOR, False)],
        [("   ↳ Four-Primitives Drivers:", DIM_COLOR, False)],
        [("     • Compute: V8 Isolates with isolated memory ceilings", TEXT_COLOR, False)],
        [("     • State:   SQLite local transactional engine (.railfog/data/kv.db)", TEXT_COLOR, False)],
        [("     • Data:    Direct file storage (.railfog/data/objects/)", TEXT_COLOR, False)],
        [("     • Signal:  In-memory FIFO queue with exponential backoff & DLQ", TEXT_COLOR, False)],
    ]
    for _ in range(12):
        frames.append(render_frame(boot_lines, title="railfog dev — local parity development server"))

    # Incoming request phase
    req_lines = boot_lines + [
        [("")],
        [("POST", GREEN_BOLD, True), (" /upload ", CYAN_COLOR, False), ("200 OK (1.1ms)", TEXT_COLOR, False)],
        [("  ↳ c.data.presign: ", CYAN_COLOR, False), ("Generated direct PUT URL for key '7c9e-7425'", DIM_COLOR, False)],
        [("  ↳ c.signal.send:  ", CYAN_COLOR, False), ("Enqueued job { key: '7c9e-7425' } to 'app:jobs'", DIM_COLOR, False)],
        [("QUEUE", GREEN_BOLD, True), (" app:jobs ", CYAN_COLOR, False), ("ACK (2.4ms)", TEXT_COLOR, False)],
        [("  ↳ ctx.state.get:  ", CYAN_COLOR, False), ("Dedupe check passed", DIM_COLOR, False)],
        [("  ↳ ctx.data.get:   ", CYAN_COLOR, False), ("Read 1.4 MB payload stream", DIM_COLOR, False)],
        [("  ↳ ctx.state.set:  ", CYAN_COLOR, False), ("Updated ['files', '7c9e-7425'] status='processed'", DIM_COLOR, False)],
    ]
    for i in range(35):
        frames.append(render_frame(
            req_lines,
            cursor_pos=(len(req_lines) - 1, 75),
            cursor_visible=(i % 6 < 3),
            title="railfog dev — local parity development server"
        ))

    build_gif_from_frames(frames, "docs/assets/cli-dev.gif", fps=fps)

# =============================================================================
# SCENARIO 5: Deployment Pipeline (rail deploy)
# =============================================================================
def generate_deploy_gif():
    frames = []
    fps = 10

    cmd = "rail deploy --dry-run"
    cur_cmd = ""
    for char in cmd:
        cur_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cur_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 27 + len(cur_cmd)),
            cursor_visible=True,
            title="railfog deploy — production packaging & isolate verification"
        ))

    for s in ["⠋", "⠙", "⠹", "⠸"]:
        frames.append(render_frame([
            [("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
            [(f"  {s} Validating manifest and packaging function isolates...", CYAN_COLOR, False)],
        ], title="railfog deploy — production packaging & isolate verification"))

    lines = [
        [("railfog@v8:~/my-service$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)],
        [("[+] Static verification passed (zero errors)", GREEN_BOLD, True)],
        [("[+] Packaging 2 function isolates:", CYAN_COLOR, True)],
        [("    • api.ts        (Compute + Data.read/write + Signal.send) → 4.2 KB bundle", TEXT_COLOR, False)],
        [("    • processor.ts  (Compute + State.read/write + Data.read)   → 3.8 KB bundle", TEXT_COLOR, False)],
        [("")],
        [("┌── Deployment Summary (Dry Run) ────────────────────────────────────────┐", DIM_COLOR, False)],
        [("│  Station:    ", CYAN_COLOR, True), ("my-service", MAGENTA_COLOR, True), ("                                                │", DIM_COLOR, False)],
        [("│  Revision:   ", CYAN_COLOR, True), ("rev_8f1a09d3b4e2 (Immutable content-addressed SHA-256)   │", YELLOW_COLOR, False)],
        [("│  Routes:     ", CYAN_COLOR, True), ("/upload → api                                            │", GREEN_BOLD, False)],
        [("│  Queues:     ", CYAN_COLOR, True), ("app:jobs → processor                                      │", GREEN_BOLD, False)],
        [("│  Target:     ", CYAN_COLOR, True), ("Production Cluster • Shared-Nothing V8 Isolates          │", TEXT_COLOR, False)],
        [("│  Status:     ", CYAN_COLOR, True), ("[+] Ready to deploy", GREEN_BOLD, True), ("                                          │", DIM_COLOR, False)],
        [("└────────────────────────────────────────────────────────────────────────┘", DIM_COLOR, False)],
    ]
    for i in range(35):
        frames.append(render_frame(
            lines,
            cursor_pos=(len(lines) - 1, 75),
            cursor_visible=(i % 6 < 3),
            title="railfog deploy — production packaging & isolate verification"
        ))

    build_gif_from_frames(frames, "docs/assets/cli-deploy.gif", fps=fps)

# =============================================================================
# SCENARIO 6: Platform Health Diagnostics (rail doctor)
# =============================================================================
def generate_doctor_gif():
    frames = []
    fps = 10

    cmd = "rail doctor"
    cur_cmd = ""
    for char in cmd:
        cur_cmd += char
        frames.append(render_frame(
            [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cur_cmd, CMD_COLOR, False)]],
            cursor_pos=(0, 14 + len(cur_cmd)),
            cursor_visible=True,
            title="railfog doctor — system health & isolate diagnostics"
        ))

    checks = [
        ("Deno Runtime:         v2.0+ (LTS strict mode active)", "[✓]"),
        ("V8 Engine:            Isolate creation latency 0.38ms (Target: < 2ms)", "[✓]"),
        ("Web Standards:        Request, Response, ReadableStream, URLPattern native", "[✓]"),
        ("SQLite Storage:       WAL mode enabled, zero lock contention", "[✓]"),
        ("Egress Firewall:      Capability-scoped network policy enforcer active", "[✓]"),
        ("Security Isolation:   Zero ambient authority verified (PLAT-4/5/6/7)", "[✓]"),
    ]

    cur_checks = []
    for c_text, c_mark in checks:
        cur_checks.append([
            (f"{c_mark} ", GREEN_BOLD, True),
            (c_text, TEXT_COLOR, False)
        ])
        for _ in range(2):
            frames.append(render_frame(
                [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)]] + cur_checks,
                title="railfog doctor — system health & isolate diagnostics"
            ))

    final_lines = [[("railfog@v8:~$ ", PROMPT_COLOR, True), (cmd, CMD_COLOR, False)]] + cur_checks + [
        [("")],
        [("[+] System healthy. Ready for local development and production deployments.", GREEN_BOLD, True)]
    ]

    for i in range(35):
        frames.append(render_frame(
            final_lines,
            cursor_pos=(len(final_lines) - 1, 79),
            cursor_visible=(i % 6 < 3),
            title="railfog doctor — system health & isolate diagnostics"
        ))

    build_gif_from_frames(frames, "docs/assets/cli-doctor.gif", fps=fps)

if __name__ == "__main__":
    print("Generating smooth, realistic terminal recording GIFs for RailFog v0.9.2...")
    generate_demo_gif()
    generate_init_gif()
    generate_check_gif()
    generate_dev_gif()
    generate_deploy_gif()
    generate_doctor_gif()
    print("All 6 realistic GIFs generated successfully!")
