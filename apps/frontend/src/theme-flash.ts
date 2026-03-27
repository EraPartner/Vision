(function () {
    try {
        const t = localStorage.getItem('vision_theme');
        // Default to dark if not set
        if (t === 'light') {
            document.documentElement.classList.remove('dark');
        } else {
            document.documentElement.classList.add('dark');
        }
    } catch (e) {
        document.documentElement.classList.add('dark');
    }
})();
