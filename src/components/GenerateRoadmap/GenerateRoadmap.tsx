import { useEffect, useRef, useState, type FormEvent } from 'react';
import './GenerateRoadmap.css';
import { useToast } from '../../hooks/use-toast';
import { generateAIRoadmapFromText } from '../../../editor/utils/roadmap-generator';
import { renderFlowJSON } from '../../../editor/renderer/renderer';
import { replaceChildren } from '../../lib/dom';
import { readAIRoadmapStream } from '../../helper/read-stream';
import { isLoggedIn, removeAuthToken } from '../../lib/jwt';
import { RoadmapSearch } from './RoadmapSearch.tsx';
import { Spinner } from '../ReactIcons/Spinner.tsx';
import { Download, PenSquare, Wand } from 'lucide-react';
import { ShareRoadmapButton } from '../ShareRoadmapButton.tsx';
import { httpGet, httpPost } from '../../lib/http.ts';
import { pageProgressMessage } from '../../stores/page.ts';
import {
  deleteUrlParam,
  getUrlParams,
  setUrlParams,
} from '../../lib/browser.ts';
import { downloadGeneratedRoadmapImage } from '../../helper/download-image.ts';
import { showLoginPopup } from '../../lib/popup.ts';

const ROADMAP_ID_REGEX = new RegExp('@ROADMAPID:(\\w+)@');

export function GenerateRoadmap() {
  const roadmapContainerRef = useRef<HTMLDivElement>(null);

  const { id: roadmapId } = getUrlParams() as { id: string };
  const toast = useToast();

  const [hasSubmitted, setHasSubmitted] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(false);
  const [roadmapTopic, setRoadmapTopic] = useState('');
  const [generatedRoadmap, setGeneratedRoadmap] = useState('');

  const [roadmapLimit, setRoadmapLimit] = useState(0);
  const [roadmapLimitUsed, setRoadmapLimitUsed] = useState(0);

  const renderRoadmap = async (roadmap: string) => {
    const { nodes, edges } = generateAIRoadmapFromText(roadmap);
    const svg = await renderFlowJSON({ nodes, edges });
    if (roadmapContainerRef?.current) {
      replaceChildren(roadmapContainerRef?.current, svg);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setHasSubmitted(true);

    if (!roadmapTopic) {
      toast.error('Please enter a topic');
      setIsLoading(false);
      return;
    }

    if (roadmapLimitUsed >= roadmapLimit) {
      toast.error('You have reached your limit of generating roadmaps');
      setIsLoading(false);
      return;
    }

    deleteUrlParam('id');

    const response = await fetch(
      `${import.meta.env.PUBLIC_API_URL}/v1-generate-ai-roadmap`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ topic: roadmapTopic }),
      },
    );

    if (!response.ok) {
      const data = await response.json();

      toast.error(data?.message || 'Something went wrong');
      setIsLoading(false);

      // Logout user if token is invalid
      if (data.status === 401) {
        removeAuthToken();
        window.location.reload();
      }
    }

    const reader = response.body?.getReader();

    if (!reader) {
      setIsLoading(false);
      toast.error('Something went wrong');
      return;
    }

    await readAIRoadmapStream(reader, {
      onStream: async (result) => {
        if (result.includes('@ROADMAPID')) {
          // @ROADMAPID: is a special token that we use to identify the roadmap
          // @ROADMAPID:1234@ is the format, we will remove the token and the id
          // and replace it with a empty string
          const roadmapId = result.match(ROADMAP_ID_REGEX)?.[1] || '';
          setUrlParams({ id: roadmapId });
          result = result.replace(ROADMAP_ID_REGEX, '');
        }

        await renderRoadmap(result);
      },
      onStreamEnd: async (result) => {
        result = result.replace(ROADMAP_ID_REGEX, '');
        setGeneratedRoadmap(result);
        loadAIRoadmapLimit().finally(() => {});
      },
    });

    setIsLoading(false);
  };

  const editGeneratedRoadmap = async () => {
    if (!isLoggedIn()) {
      showLoginPopup();
      return;
    }

    pageProgressMessage.set('Redirecting to Editor');

    const { nodes, edges } = generateAIRoadmapFromText(generatedRoadmap);

    const { response, error } = await httpPost<{
      roadmapId: string;
    }>(`${import.meta.env.PUBLIC_API_URL}/v1-edit-ai-generated-roadmap`, {
      title: roadmapTopic,
      nodes: nodes.map((node) => ({
        ...node,

        // To reset the width and height of the node
        // so that it can be calculated based on the content in the editor
        width: undefined,
        height: undefined,
        style: {
          ...node.style,
          width: undefined,
          height: undefined,
        },
      })),
      edges,
    });

    if (error || !response) {
      toast.error(error?.message || 'Something went wrong');
      setIsLoading(false);
      return;
    }

    window.location.href = `${import.meta.env.PUBLIC_EDITOR_APP_URL}/${response.roadmapId}`;
  };

  const downloadGeneratedRoadmap = async () => {
    pageProgressMessage.set('Downloading Roadmap');

    const node = document.getElementById('roadmap-container');
    if (!node) {
      toast.error('Something went wrong');
      return;
    }

    try {
      await downloadGeneratedRoadmapImage(roadmapTopic, node);
      pageProgressMessage.set('');
    } catch (error) {
      console.error(error);
      toast.error('Something went wrong');
    }
  };

  const loadAIRoadmapLimit = async () => {
    const { response, error } = await httpGet<{
      limit: number;
      used: number;
    }>(`${import.meta.env.PUBLIC_API_URL}/v1-get-ai-roadmap-limit`);

    if (error || !response) {
      toast.error(error?.message || 'Something went wrong');
      return;
    }

    const { limit, used } = response;
    setRoadmapLimit(limit);
    setRoadmapLimitUsed(used);
  };

  const loadAIRoadmap = async (roadmapId: string) => {
    pageProgressMessage.set('Loading Roadmap');

    const { response, error } = await httpGet<{
      topic: string;
      data: string;
    }>(`${import.meta.env.PUBLIC_API_URL}/v1-get-ai-roadmap/${roadmapId}`);

    if (error || !response) {
      toast.error(error?.message || 'Something went wrong');
      setIsLoading(false);
      return;
    }

    const { topic, data } = response;
    await renderRoadmap(data);

    setRoadmapTopic(topic);
    setGeneratedRoadmap(data);
  };

  useEffect(() => {
    loadAIRoadmapLimit().finally(() => {});
  }, []);

  useEffect(() => {
    if (!roadmapId) {
      return;
    }

    setHasSubmitted(true);
    loadAIRoadmap(roadmapId).finally(() => {
      pageProgressMessage.set('');
    });
  }, [roadmapId]);

  if (!hasSubmitted) {
    return (
      <RoadmapSearch
        roadmapTopic={roadmapTopic}
        setRoadmapTopic={setRoadmapTopic}
        handleSubmit={handleSubmit}
        limit={roadmapLimit}
        limitUsed={roadmapLimitUsed}
      />
    );
  }

  const pageUrl = `https://roadmap.sh/ai?id=${roadmapId}`;

  return (
    <section className="flex flex-grow flex-col bg-gray-100">
      <div className="flex items-center justify-center border-b bg-white py-6">
        {isLoading && (
          <span className="flex items-center gap-2 rounded-full bg-black px-3 py-1 text-white">
            <Spinner isDualRing={false} innerFill={'white'} />
            Generating roadmap ..
          </span>
        )}
        {!isLoading && (
          <div className="flex max-w-[600px] flex-grow flex-col items-center">
            <div className="mt-2 flex w-full items-center justify-between text-sm">
              <span className="text-gray-800">
                {roadmapLimitUsed} of {roadmapLimit} roadmaps generated
                {!isLoggedIn() && (
                  <>
                    {' '}
                    <button
                      className="font-medium text-black underline underline-offset-2"
                      onClick={showLoginPopup}
                    >
                      Login to increase your limit
                    </button>
                  </>
                )}
              </span>
            </div>
            <form
              onSubmit={handleSubmit}
              className="my-3 flex w-full flex-row items-center justify-center gap-2"
            >
              <input
                type="text"
                autoFocus
                placeholder="e.g. Ansible"
                className="flex-grow rounded-md border border-gray-400 px-3 py-2 transition-colors focus:border-black focus:outline-none"
                value={roadmapTopic}
                onInput={(e) =>
                  setRoadmapTopic((e.target as HTMLInputElement).value)
                }
              />
              <button
                type={'submit'}
                className="flex flex-shrink-0 items-center gap-2 rounded-md border border-black bg-black px-4 py-2 text-white"
              >
                <Wand size={20} />
                Generate
              </button>
            </form>
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-md bg-yellow-400 py-1.5 pl-2.5 pr-3 text-xs font-medium transition-opacity duration-300 hover:bg-yellow-500 sm:text-sm"
                  onClick={downloadGeneratedRoadmap}
                >
                  <Download size={15} />
                  Download
                </button>
                {roadmapId && (
                  <ShareRoadmapButton
                    description={`Check out ${roadmapTopic} roadmap I generated on roadmap.sh`}
                    pageUrl={pageUrl}
                  />
                )}
              </div>
              <button
                className="inline-flex items-center justify-center gap-2 rounded-md bg-gray-200 py-1.5 pl-2.5 pr-3 text-xs font-medium text-black transition-colors transition-opacity duration-300 hover:bg-gray-300 sm:text-sm"
                onClick={editGeneratedRoadmap}
                disabled={isLoading}
              >
                <PenSquare size={15} />
                Edit in Editor
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        ref={roadmapContainerRef}
        id="roadmap-container"
        className="relative px-4 py-5 [&>svg]:mx-auto [&>svg]:max-w-[1300px]"
      />
    </section>
  );
}