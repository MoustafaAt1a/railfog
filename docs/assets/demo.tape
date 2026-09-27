Output docs/assets/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 820
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 40
Set TypingSpeed 40ms
Set Padding 20

# Setup environment quietly
Hide
Type "clear" Enter
Sleep 1s
Show

# 1. Check RailFog CLI Version & Primitives
Type "rail --version" Sleep 300ms Enter
Sleep 1500ms

# 2. Scaffold a new project with the Four-Primitives worked-example template
Type "rail init upload-pipeline --template worked-example" Sleep 400ms Enter
Sleep 3s

# 3. Enter project directory
Type "cd upload-pipeline" Sleep 300ms Enter
Sleep 1s

# 4. Run static validation across routes, isolation, and capabilities
Type "rail check" Sleep 300ms Enter
Sleep 2500ms

# 5. Start the local multi-tenant development runtime
Type "rail dev --port 8000" Sleep 400ms Enter
Sleep 4s

# 6. Stop development server gracefully
Ctrl+C
Sleep 1s

# 7. Perform a dry-run production deployment package
Type "rail deploy --dry-run" Sleep 400ms Enter
Sleep 3s

# Finished demo walkthrough
Type "echo '✨ RailFog v0.9.2 Four-Primitives experience verified.'" Sleep 300ms Enter
Sleep 2s
