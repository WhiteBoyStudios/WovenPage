# Keeping Wovenpage original

This is a working note for whoever builds on this code, not legal advice. Before releasing a product, have a lawyer review it; the checklist at the end says what to ask them.

## What is and is not protected

The rules of thumb this project was built under:

- **Ideas and functions are free; expression is not.** "A visual editor beside a code editor", "a file tree", "a property panel", "publish over FTP" are functional ideas found in many tools and none of them belongs to anyone. What can belong to someone is their code, their specific screen designs and artwork, their text, their names, and patented techniques.
- **So the test is never "does it do similar things?"** It is "was anything of theirs taken?" - code, layouts, icons, wording, names, file formats, or the distinctive look of the product taken as a whole.

## What was done here

**No reference to another product's implementation.** The code was written from the requirements list and from public web standards (HTML, CSS, DOM, HTTP, FTP, SFTP). No commercial product's source, binaries, documentation, resource files or screenshots were consulted, decompiled or adapted.

**A different architecture, chosen on its merits.** The core mechanism - numbering elements by open-tag order, stamping addresses onto a served copy, and turning gestures into minimal text patches guarded by epochs - was designed for this project and is documented in ARCHITECTURE.md. It is not a reconstruction of how any other editor works.

**Own vocabulary.** The product's terms were chosen for what they mean here, not borrowed:

| Wovenpage says | Meaning |
| --- | --- |
| Canvas / Split / Source | The three ways to view a page |
| Layout, slot, fill | A master page, a hole in it, and a page's content for that hole |
| Part | A reusable fragment with parameters |
| Inspector, "Write to" | The style panel and its destination control |
| Site, destination | A project, and a place it is published to |
| Interact | Using the page as a visitor would |
| Problems | Validation results |

**Own formats.** `<w-page>`, `<w-fill>`, `<w-slot>`, `<w-part>`, `{{name | fallback}}` and `wovenpage.json` are this project's inventions. The app does not read, write or imitate any other tool's template, library or site-definition format.

**Own interface.** The arrangement is a conventional workbench (panels around a work area), which is common to the whole category. Within that, the specifics are this project's: the icon rail, the three-way view switch, the "Write to" destination, the two-colour convention (one for the page's own content, one for content shared through layouts and parts), the woven canvas backdrop, the two themes and their palettes.

**Own artwork.** Every icon and the product mark are drawn in `renderer/core/icons.ts` and `panels/Launcher.ts` as original vector paths. No icon font or third-party icon set is used for the product's own interface. (Monaco ships its own icon font for editor widgets; see below.)

**Own text.** All interface wording, messages and documentation were written for this product.

**Own example content.** The starter site, including its images, was made for this project.

## Third-party components

Everything bundled is open source and used under its licence. Ship the licence texts with the installer.

| Component | Use | Licence |
| --- | --- | --- |
| Electron (with Chromium and Node.js) | Application shell | MIT (Chromium and Node carry their own notices) |
| Monaco Editor | Code editor, including the icon font used inside editor widgets | MIT; its bundled third-party notices are in `node_modules/monaco-editor/ThirdPartyNotices.txt` |
| basic-ftp | FTP and FTPS client | MIT |
| ssh2, ssh2-sftp-client | SFTP client | MIT; Apache-2.0 |
| acorn | JavaScript syntax check | MIT |
| sass (Dart Sass) | Compiles `.scss` stylesheets | MIT |
| Instrument Sans | Interface typeface | SIL Open Font License 1.1 |
| Commit Mono | Code typeface | SIL Open Font License 1.1 |
| esbuild, TypeScript, tsx, Playwright, electron-builder | Build and test only; not shipped | MIT / Apache-2.0 |

Verify each licence against the exact version in `package-lock.json` before release; a tool such as `license-checker` can generate the notices file.

## Rules for future work

1. **Design from the need, not from a competitor.** When adding a feature, write down what the user is trying to do and design from that. Do not open another product to see how it lays the feature out.
2. **Never copy assets.** No icons, cursors, illustrations, sounds, sample files, templates or snippets from another product. Draw new ones or use openly licensed ones and record the licence.
3. **Never copy text.** Menu names, tooltips, error messages and help text are written fresh.
4. **No reverse engineering.** Do not decompile, disassemble, or inspect another product's binaries, resources or network traffic.
5. **No format compatibility by imitation.** Do not read or write another tool's proprietary project, template or library formats. Interoperate through open standards.
6. **Clean contributions.** Contributors must not bring code or knowledge of trade secrets from a previous employer's product. Record who wrote what.
7. **Check every dependency's licence** before adding it, and avoid copyleft licences that do not fit a closed-source product unless that is a deliberate decision.
8. **Do not trade on another product's name.** Do not describe this product as a clone of, replacement for, or "like" a named product in its interface, marketing or store listing.

## Before shipping: what to ask a lawyer

- **Name and mark.** "Wovenpage" was chosen as a distinctive working name; no trademark or domain search has been done. Clear the name in the markets you will sell in, or replace it.
- **Patents.** No patent search was done. Techniques in this field may be patented; a freedom-to-operate review is the only way to know.
- **Third-party notices.** Confirm the notices file is complete and that the licences' conditions (attribution, licence text, source offers if any) are met in the installer.
- **Overall look.** Have someone who knows the competing products compare the finished interface against them for unintended resemblance.
- **Your own licence.** `package.json` says `UNLICENSED`; decide how the product is licensed and what the end-user terms are.
