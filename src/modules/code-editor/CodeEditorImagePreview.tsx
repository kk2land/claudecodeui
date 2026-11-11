import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getPreviewMimeType } from '@/modules/code-editor/utils/previewableFile';
import { api } from '@/shared/api';

type CodeEditorImagePreviewProps = {
  projectId?: string;
  filePath: string;
  fileName: string;
};

/** Used by CodeEditor to display image bytes without opening a text buffer. */
export default function CodeEditorImagePreview({ projectId, filePath, fileName }: CodeEditorImagePreviewProps) {
  const { t } = useTranslation('codeEditor');
  // Authenticated file reads become a temporary URL the image element can use.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Fetch and decode failures leave the original-file download available.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;

    const loadImage = async () => {
      try {
        if (!projectId) throw new Error('Missing project identifier');
        const response = await api.readFileBlob(projectId, filePath, { signal: controller.signal });
        if (!response.ok) throw new Error(`Image preview failed: ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        // The raw endpoint may return application/octet-stream; preserve the
        // bytes and give the browser the MIME type of the image being opened.
        objectUrl = URL.createObjectURL(new Blob([blob], { type: getPreviewMimeType(fileName) }));
        setImageUrl(objectUrl);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Error loading image preview:', error);
        setFailed(true);
      }
    };

    void loadImage();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileName, filePath, projectId]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4">
      {failed ? (
        <p role="alert" className="text-sm text-muted-foreground">{t('filePreview.error', 'Unable to display this file.')}</p>
      ) : imageUrl ? (
        <img src={imageUrl} alt={fileName} className="max-h-full max-w-full object-contain" onError={() => setFailed(true)} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">{t('filePreview.loading', 'Loading preview...')}</p>
      )}
    </div>
  );
}
