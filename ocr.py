import sys
import json
import fitz  # PyMuPDF
import easyocr
import os

def extract_text_from_pdf(pdf_path):
    doc = fitz.open(pdf_path)
    text = ""
    quality_scores = []

    for page_num in range(len(doc)):
        page = doc.load_page(page_num)
        page_text = page.get_text()

        if page_text.strip():
            text += f"--- PAGE {page_num + 1} ---\n{page_text}\n\n"
            # Estimate quality based on text length (simple heuristic)
            quality_scores.append(min(len(page_text.strip()) / 500, 1))
        else:
            # If no text, render page to image and OCR
            pix = page.get_pixmap()
            img_path = f"temp_page_{page_num}.png"
            pix.save(img_path)

            reader = easyocr.Reader(['es'])  # Spanish language
            results = reader.readtext(img_path, detail=1)

            page_ocr_text = ""
            confidences = []

            for (bbox, text_part, confidence) in results:
                page_ocr_text += text_part + " "
                confidences.append(confidence)

            if confidences:
                avg_conf = sum(confidences) / len(confidences)
                quality_scores.append(avg_conf)
            else:
                quality_scores.append(0.1)  # Low quality if no text found

            text += f"--- PAGE {page_num + 1} ---\n{page_ocr_text}\n\n"

            os.remove(img_path)  # Clean up

    doc.close()

    average_quality = sum(quality_scores) / len(quality_scores) if quality_scores else 0.5
    return text.strip(), average_quality

def extract_text_from_image(img_path):
    reader = easyocr.Reader(['es'])  # Spanish language
    results = reader.readtext(img_path, detail=1)

    text = ""
    confidences = []

    for (bbox, text_part, confidence) in results:
        text += text_part + " "
        confidences.append(confidence)

    average_quality = sum(confidences) / len(confidences) if confidences else 0.5
    return text.strip(), average_quality

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: python ocr.py <file_path>"}))
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.exists(file_path):
        print(json.dumps({"error": "File not found"}))
        sys.exit(1)

    try:
        if file_path.lower().endswith('.pdf'):
            text, quality = extract_text_from_pdf(file_path)
        else:
            text, quality = extract_text_from_image(file_path)

        print(json.dumps({"text": text, "quality": quality}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
