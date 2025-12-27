# PWA Icons Setup

## Quick Setup

The app now has PWA manifest support! To complete the setup:

### Convert SVG Icons to PNG

You have 3 options:

#### Option 1: Use ImageMagick (Command Line)
```bash
brew install imagemagick  # macOS
# or: sudo apt-get install imagemagick  # Linux

convert icon-192.svg icon-192.png
convert icon-512.svg icon-512.png
convert icon-180.svg icon-180.png
```

#### Option 2: Use Online Converter
1. Go to https://cloudconvert.com/svg-to-png
2. Upload each SVG file (icon-192.svg, icon-512.svg, icon-180.svg)
3. Set output size to match filename (192x192, 512x512, 180x180)
4. Download and save in project root

#### Option 3: Use macOS Preview
1. Open each SVG in Preview
2. File → Export
3. Format: PNG
4. Save with correct filename

### Testing the PWA

#### On iPhone:
1. Deploy to HTTPS URL (required for PWA)
2. Open in Safari
3. Tap Share button → "Add to Home Screen"
4. Launch from home screen

#### On Android:
1. Open in Chrome
2. Tap menu → "Install app"
3. Launch from app drawer

### Current Files

- ✅ `manifest.json` - PWA configuration
- ✅ `index.html` - Updated with PWA meta tags
- ✅ `icon-192.svg`, `icon-512.svg`, `icon-180.svg` - Icon templates

### What You Get

- 🏠 App icon on home screen
- 📱 Full-screen experience (no browser UI)
- ⚡ Fast loading
- 🌐 Works offline (after first visit)
- 🎯 Native app feel

### Deploy Options

```bash
# Netlify
netlify deploy --prod

# Vercel
vercel --prod

# Or use npm run dev -- --host for local testing
npm run dev -- --host
```

Then access from iPhone/Android on same network!
