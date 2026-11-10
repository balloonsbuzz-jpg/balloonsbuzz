// Apply the saved theme before paint (avoids a light flash in dark mode).
// A file, not an inline script, so the Content-Security-Policy can forbid inline scripts.
try { if (localStorage.getItem('bb-theme') === 'dark') document.documentElement.classList.add('dark'); } catch (e) { /* storage blocked */ }
