class DocReader {
    constructor(opts) {
        const pdfjsAsset = asset => new URL("node_modules/pdfjs-dist/"+asset, document.baseURI).href;
        const modalElementId = "modal_" + opts.modalId;
        const path = opts.path;
        const scale = 1;
        const canvas = document.getElementById(modalElementId).querySelector(".pdf_canvas");
        let pdfDoc = null,
            pageNum = 1,
            pageRendering = false,
            pageNumPending = null,
            zoom = 100

        this.renderPage = (num) => {
            pageRendering = true;
            pdfDoc.getPage(num).then((page) => {
                const viewport = page.getViewport({ scale: scale });
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                const renderContext = {
                    canvas: canvas,
                    viewport: viewport,
                };
                const renderTask = page.render(renderContext);
                renderTask.promise.then(() => {
                    pageRendering = false;
                    if (pageNumPending !== null) {
                        this.renderPage(pageNumPending);
                        pageNumPending = null;
                    }
                });
            });
            document.getElementById(modalElementId).querySelector(".page_num").textContent = num;
        }

        this.queueRenderPage = (num) => {
            if (pageRendering) {
                pageNumPending = num;
            } else {
                this.renderPage(num);
            }
        }

        this.onPrevPage = () => {
            if (pageNum <= 1) {
                return;
            }
            pageNum--;
            this.queueRenderPage(pageNum);
        }

        this.onNextPage = () => {
            if (pdfDoc === null || pageNum >= pdfDoc.numPages) {
                return;
            }
            pageNum++;
            this.queueRenderPage(pageNum);
        }

        this.zoomIn = () => {
            if (zoom >= 200) {
                return;
            }
            zoom = zoom + 10;
            canvas.style.zoom = zoom + "%";
        }

        this.zoomOut = () => {
            if (zoom <= 50) {
                return;
            }
            zoom = zoom - 10;
            canvas.style.zoom = zoom + "%";
        }

        document.getElementById(modalElementId).querySelector(".previous_page").addEventListener('click', this.onPrevPage);
        document.getElementById(modalElementId).querySelector(".next_page").addEventListener('click', this.onNextPage);
        document.getElementById(modalElementId).querySelector(".zoom_in").addEventListener('click', this.zoomIn);
        document.getElementById(modalElementId).querySelector(".zoom_out").addEventListener('click', this.zoomOut);

        // Read the file here because a "C:/..." path isn't a URL pdf.js could load
        Promise.all([import(pdfjsAsset("build/pdf.min.mjs")), require("fs").promises.readFile(path)]).then(([pdfjsLib, data]) => {
            pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsAsset("build/pdf.worker.min.mjs");

            return pdfjsLib.getDocument({
                data: new Uint8Array(data),
                isEvalSupported: false,
                cMapUrl: pdfjsAsset("cmaps/"),
                cMapPacked: true,
                standardFontDataUrl: pdfjsAsset("standard_fonts/"),
                wasmUrl: pdfjsAsset("wasm/")
            }).promise;
        }).then((pdfDoc_) => {
            pdfDoc = pdfDoc_;
            document.getElementById(modalElementId).querySelector(".page_count").textContent = pdfDoc.numPages;
            this.renderPage(pageNum);
        }).catch(e => {
            new Modal({
                type: "error",
                title: "Failed to open PDF",
                message: window._escapeHtml(e.message)
            });
        });
    }
}

module.exports = {
    DocReader
};
