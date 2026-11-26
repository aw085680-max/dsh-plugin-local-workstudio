# Third-party notices

Local Agent Studio derives from [Agent Collaboration v0.5.0](https://github.com/Leo-sail/dsh-plugin-agent-collaboration/tree/v0.5.0) by leochang (Leo-sail). See the [MIT license](LICENSE) for the upstream copyright notice.

The browser bundle at `components/ui-agent-community/lib/client.js` includes the libraries below. Their license texts accompany this distribution in `licenses/`.

| Library | Version | Included license | Upstream |
| --- | --- | --- | --- |
| PDF.js (`pdfjs-dist`) | 6.3.289 | [Apache-2.0](licenses/PDF.js.txt) | [Mozilla](https://github.com/mozilla/pdf.js) |
| docx-preview | 0.3.7 | [Apache-2.0](licenses/docx-preview.txt) | [Volodymyr Baydalka](https://github.com/zVolodymyr/docxjs) |
| JSZip | 3.10.2 | [MIT selection](licenses/JSZip-MIT.txt) | [Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso](https://github.com/Stuk/jszip) |
| SheetJS Community Edition (`xlsx`) | 0.18.5 | [Apache-2.0](licenses/SheetJS.txt) | [SheetJS LLC](https://github.com/SheetJS/sheetjs) |
| React JSX runtime | — | [MIT](licenses/React.txt) | [React](https://github.com/facebook/react) |

The PDF.js worker is bundled as a string and starts as a Blob-URL module worker. The bundle omits PDF.js standard fonts, CMaps and WASM decoders. PDFs that rely on non-embedded standard fonts use the browser's system fonts, and some image codecs may warn.
