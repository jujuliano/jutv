import { useEffect, useState } from 'react';
import { getYouTubeVideoId } from '../utils/helpers';
import { Play, Tv } from 'lucide-react';

interface VideoPlayerProps {
  youtubeUrl: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  controls: boolean;
}

export default function VideoPlayer({
  youtubeUrl,
  autoplay,
  loop,
  muted,
  controls,
}: VideoPlayerProps) {
  const [videoId, setVideoId] = useState<string | null>(null);

  useEffect(() => {
    const id = getYouTubeVideoId(youtubeUrl);
    setVideoId(id);
  }, [youtubeUrl]);

  if (!videoId) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950 text-zinc-400 p-8 text-center">
        <div className="p-4 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mb-4 animate-pulse">
          <Tv size={42} id="no-video-icon" />
        </div>
        <h3 className="text-xl font-medium text-white mb-2" id="no-video-heading">
          Nenhum vídeo do YouTube configurado
        </h3>
        <p className="max-w-md text-sm text-zinc-500" id="no-video-desc">
          Abra o menu de configurações (ícone de engrenagem) e coloque um link de vídeo do YouTube válido para exibi-lo aqui.
        </p>
      </div>
    );
  }

  // Construct standard YouTube embed queries with parameters
  const queryParams = new URLSearchParams();
  queryParams.append('autoplay', autoplay ? '1' : '0');
  queryParams.append('mute', muted ? '1' : '0');
  queryParams.append('controls', controls ? '1' : '0');
  queryParams.append('rel', '0');
  queryParams.append('modestbranding', '1');
  queryParams.append('playsinline', '1');
  queryParams.append('enablejsapi', '1');

  if (loop) {
    queryParams.append('loop', '1');
    // YouTube requires a playlist parameter containing the same video ID to loop single videos correctly
    queryParams.append('playlist', videoId);
  }

  const embedUrl = `https://www.youtube.com/embed/${videoId}?${queryParams.toString()}`;

  return (
    <div className="absolute inset-0 w-full h-full bg-black overflow-hidden z-0" id="video-wrapper">
      {/* 
        This is an absolute cover iframe. Using 16:9 standard fitting. 
        If the user wants a full responsive cover, we absolute align it.
      */}
      <iframe
        id="youtube-player-iframe"
        src={embedUrl}
        title="YouTube Video Player"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="w-full h-full border-0 absolute inset-0"
      />
    </div>
  );
}
