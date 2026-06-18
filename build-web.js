const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_DIR = path.join(__dirname, 'dist');
const OUT_DIR = path.join(__dirname, 'build-web');

function build() {
  console.log('🚀 Starting secure web build process...');

  // 1. Recreate output directory
  if (fs.existsSync(OUT_DIR)) {
    console.log('🧹 Cleaning existing build-web directory...');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR);

  // 2. Copy and protect index.html
  console.log('📄 Copying and protecting index.html...');
  let indexHtml = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');

  // Inject script to block right-click and DevTools keyboard shortcuts
  const protectionScript = `
  <script>
    // Disable right-click context menu
    document.addEventListener('contextmenu', event => event.preventDefault());

    // Disable F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C, Ctrl+U (view source)
    document.addEventListener('keydown', event => {
      if (
        event.key === 'F12' ||
        (event.ctrlKey && event.shiftKey && ['I', 'J', 'C'].includes(event.key.toUpperCase())) ||
        (event.ctrlKey && event.key.toLowerCase() === 'u')
      ) {
        event.preventDefault();
      }
    });
  </script>
  </body>`;

  indexHtml = indexHtml.replace('</body>', protectionScript);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml);

  // 3. Copy style.css
  console.log('🎨 Copying style.css...');
  fs.copyFileSync(path.join(SRC_DIR, 'style.css'), path.join(OUT_DIR, 'style.css'));

  // 4. Obfuscate and copy app.js
  console.log('🛡️ Reading and obfuscating app.js...');
  const appJs = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');

  const obfuscationResult = JavaScriptObfuscator.obfuscate(appJs, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    numbersToExpressions: true,
    simplify: true,
    stringArray: true,
    stringArrayThreshold: 0.8,
    splitStrings: true,
    splitStringsChunkLength: 8,
    unicodeEscapeSequence: true,
    debugProtection: true,             // Makes DevTools debugging highly difficult
    debugProtectionInterval: 4000,     // Regularly triggers debugger statements to freeze DevTools
    disableConsoleOutput: true,        // Prevents users from checking logs via console
    selfDefending: true                // Breaks the file if anyone attempts to format/beautify it
  });

  fs.writeFileSync(path.join(OUT_DIR, 'app.js'), obfuscationResult.getObfuscatedCode());

  console.log('✨ Secure web build completed successfully! Check the "build-web" folder.');
}

try {
  build();
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
