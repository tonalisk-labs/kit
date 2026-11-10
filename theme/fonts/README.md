# Fonts

Each site passes its font to `siteFont` in its `astro.config.mjs`: `'system'`, the platform's own
font, or `'palatino'`, the Palatino that Windows and Apple's systems install, with nothing to
download. Its layouts render `BodyFont` in their head (a Starlight site, `StarlightHead` as its
`Head`), which brings the font's stylesheet.

Palatino is Palatino Linotype on Windows and Palatino on the Mac, iPhone and iPad. Neither has the
music signs ♩ ♪ ♫ ♬ ♭ ♮ ♯, so STIX Two Math draws them on the Mac, iPhone and iPad, and Segoe UI
Symbol on Windows, for those signs alone. A system without Palatino, such as Android, sets the
text in its own font.
