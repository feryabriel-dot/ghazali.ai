import { useEffect, useRef, useState } from 'react';
import { APPROVED_LANGUAGES, type ApprovedLanguage } from '../shared/languages';

type Project = { id: string; title: string; language: string; durationSeconds: number; status: string; updatedAt: string; jobId?: string; jobStatus?: string; stage?: string; progress?: number; jobError?: string };
type Job = { id: string; status: string; stage: string; progress: number; error?: string; projectId: string };
type StoryScene = { title: string; location: string; visualDescription: string; cameraMovement: string; transition: string; durationSeconds: number; dialogue: { characterId: string; text: string; emotion: string }[]; narration: string };
type Story = { synopsis: string; genre: string; characters: { id: string; name: string; appearance: string; wardrobe: string; voiceDescription: string }[]; scenes: StoryScene[] };
type ProjectAsset = { id: string; kind: string; ordinal: number; status: string; content_type?: string; byte_size?: number; error?: string; metadata: Record<string, unknown> };
type ProjectDetail = { project: Project; story: Story | null; jobs: { id: string; status: string; stage: string; progress: number; error?: string; createdAt: string; updatedAt: string }[]; assets: ProjectAsset[] };

const durations = [60, 180, 300, 600, 900, 1200];
const navItems = ['Overview', 'Drama projects', 'Story & script', 'Characters', 'Storyboard', 'Image generation', 'Voice studio', 'Background music', 'Cinematic motion', 'Subtitle studio', 'Video preview', 'Rendering progress', 'Settings'];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function durationLabel(seconds: number) {
  return seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds / 60} min`;
}

function ProjectWorkspace({ detail, projects, section, onSelect, onResume, onRename, onDuplicate, onDelete }: {
  detail: ProjectDetail; projects: Project[]; section: string; onSelect: (id: string) => void;
  onResume: (jobId: string) => void; onRename: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { project, story, assets } = detail;
  const image = (index: number) => assets.find((asset) => asset.kind === 'image' && asset.ordinal === index);
  const speech = assets.filter((asset) => asset.kind === 'speech');
  const music = assets.find((asset) => asset.kind === 'music');
  const video = assets.find((asset) => asset.kind === 'video' && asset.status === 'ready');
  const selectedJob = detail.jobs[0];
  const mediaLink = (asset: ProjectAsset) => `/api/assets/${asset.id}`;

  return <section className="detail-workspace">
    <div className="detail-toolbar"><div><label className="field-label" htmlFor="open-project">OPEN PROJECT</label><select id="open-project" value={project.id} onChange={(event) => onSelect(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div><div className="detail-toolbar-actions"><button className="icon-button" onClick={onRename} title="Rename project" aria-label="Rename project">✎</button><button className="icon-button" onClick={onDuplicate} title="Duplicate project" aria-label="Duplicate project">⧉</button><button className="icon-button danger-action" onClick={onDelete} title="Delete project" aria-label="Delete project">×</button></div></div>
    <div className="detail-heading"><div className="section-index">{project.language} <span>·</span> {durationLabel(project.durationSeconds)} <span>·</span> {project.status.toUpperCase()}</div><h2>{project.title}</h2></div>
    {!story ? <div className="detail-waiting"><strong>{selectedJob?.stage || 'Story generation is waiting to start.'}</strong><p>{selectedJob?.error || 'Production assets and screenplay will appear here as saved stages finish.'}</p>{selectedJob?.status === 'failed' && <button className="secondary-button" onClick={() => onResume(selectedJob.id)}>RESUME UNFINISHED PRODUCTION ↻</button>}</div> : <>
      {section === 'Story & script' && <div className="script-view"><div className="synopsis"><span className="section-index">{story.genre.toUpperCase()} · SYNOPSIS</span><p>{story.synopsis}</p></div>{story.scenes.map((scene, index) => <article className="script-scene" key={`${scene.title}-${index}`}><div className="scene-number">SCENE {String(index + 1).padStart(2, '0')}<small>{scene.durationSeconds}s</small></div><div><h3>{scene.title}</h3><span className="scene-meta">{scene.location} · {scene.cameraMovement} · {scene.transition}</span><p className="scene-visual">{scene.visualDescription}</p><p className="scene-narration"><b>NARRATION</b> {scene.narration}</p>{scene.dialogue.map((line, lineIndex) => <p className="dialogue-line" key={lineIndex}><b>{story.characters.find((character) => character.id === line.characterId)?.name || 'CHARACTER'}</b><span>{line.text}</span><i>{line.emotion}</i></p>)}</div></article>)}</div>}
      {section === 'Characters' && <div className="character-list">{story.characters.map((character) => <article className="character-row" key={character.id}><div className="character-mark">{character.name.slice(0, 1)}</div><div><span className="section-index">CHARACTER PROFILE</span><h3>{character.name}</h3><p>{character.appearance}</p><small>WARDROBE · {character.wardrobe}</small><small>VOICE · {character.voiceDescription}</small></div></article>)}</div>}
      {(section === 'Storyboard' || section === 'Image generation') && <div className="storyboard-list">{story.scenes.map((scene, index) => { const asset = image(index); return <article className="storyboard-row" key={index}><div className="storyboard-image">{asset?.status === 'ready' ? <img src={mediaLink(asset)} alt={`Generated still for ${scene.title}`} /> : <span>{asset?.status === 'failed' ? 'IMAGE FAILED' : asset?.status === 'generating' ? 'GENERATING' : 'WAITING'}</span>}</div><div className="storyboard-copy"><span className="section-index">SCENE {String(index + 1).padStart(2, '0')} · {scene.durationSeconds} SEC</span><h3>{scene.title}</h3><p>{scene.visualDescription}</p><small>{scene.location} · {scene.cameraMovement}</small>{asset?.status === 'ready' && <a href={`${mediaLink(asset)}?download=1`}>DOWNLOAD IMAGE ↓</a>}</div></article>; })}</div>}
      {section === 'Voice studio' && <div className="asset-list">{speech.map((asset) => <article className="asset-row" key={asset.id}><div><span className="section-index">SEGMENT {String(asset.ordinal + 1).padStart(2, '0')} · {String(asset.metadata.kind || 'speech').toUpperCase()}</span><p>{String(asset.metadata.text || '')}</p><small>Scene {Number(asset.metadata.sceneIndex || 0) + 1} · {String(asset.metadata.emotion || 'neutral')}</small></div>{asset.status === 'ready' ? <audio controls preload="none" src={mediaLink(asset)} /> : <span className={`asset-state ${asset.status}`}>{asset.status}</span>}</article>)}</div>}
      {section === 'Background music' && <div className="single-asset">{music?.status === 'ready' ? <><span className="section-index">ORIGINAL AI SCORE · {story.genre.toUpperCase()}</span><h3>Production soundtrack</h3><p>Generated instrumental score, mixed below dialogue and narration.</p><audio controls preload="none" src={mediaLink(music)} /><a href={`${mediaLink(music)}?download=1`}>DOWNLOAD MUSIC ↓</a></> : <><h3>Music generation {music?.status || 'not started'}</h3><p>{music?.error || 'A real music provider is required. No substitute track is used.'}</p></>}</div>}
      {section === 'Cinematic motion' && <div className="motion-list"><p className="notice-line">IMAGE-BASED CINEMATIC MOTION · NOT AI-GENERATED VIDEO</p>{story.scenes.map((scene, index) => <div className="motion-row" key={index}><span>SCENE {String(index + 1).padStart(2, '0')}</span><strong>{scene.cameraMovement}</strong><small>{scene.transition}</small></div>)}</div>}
      {section === 'Subtitle studio' && <div className="subtitle-view"><p className="notice-line">WORD TIMING IS ESTIMATED FROM DECODED SPEECH DURATION. PROVIDER FORCED ALIGNMENT IS NOT CONFIGURED.</p>{speech.map((asset) => <div className="subtitle-line" key={asset.id}><span>{String(asset.metadata.kind || 'speech').toUpperCase()} · SCENE {Number(asset.metadata.sceneIndex || 0) + 1}</span><p>{String(asset.metadata.text || '')}</p></div>)}</div>}
      {section === 'Video preview' && <div className="video-preview">{video ? <><video controls playsInline preload="metadata" src={`/api/projects/${project.id}/preview`} /><div className="video-actions"><strong>PRODUCTION COMPLETE — READY TO DOWNLOAD</strong><a className="secondary-button" href={`/api/projects/${project.id}/download`}>DOWNLOAD MP4 ↓</a></div></> : <div className="detail-waiting"><strong>{selectedJob?.stage || 'No validated video yet.'}</strong><p>{selectedJob?.error || 'A download appears only after every required asset and the final MP4 pass validation.'}</p></div>}</div>}
      {section === 'Rendering progress' && <div className="history-list">{detail.jobs.map((job) => <article className="history-row" key={job.id}><div><strong>{job.stage}</strong><small>{new Date(job.createdAt).toLocaleString()}</small>{job.error && <p>{job.error}</p>}</div><span>{job.status.toUpperCase()} · {job.progress}%</span>{job.status === 'failed' && <button className="secondary-button" onClick={() => onResume(job.id)}>RESUME ↻</button>}</article>)}</div>}
      {section === 'Settings' && <div className="settings-view"><div><span className="section-index">PROJECT TITLE</span><p>{project.title}</p><button className="secondary-button" onClick={onRename}>RENAME PROJECT</button></div><div><span className="section-index">PROJECT HISTORY</span><p>{detail.jobs.length} saved production job(s)</p></div><div><span className="section-index">PERMANENT ACTION</span><p>Deleting a project also deletes its stored assets.</p><button className="danger-button" onClick={onDelete}>DELETE PROJECT</button></div></div>}
    </>}
  </section>;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<ApprovedLanguage>('Bahasa Indonesia');
  const [duration, setDuration] = useState(180);
  const [customDuration, setCustomDuration] = useState('');
  const [activeNav, setActiveNav] = useState('Overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const productionKey = useRef(crypto.randomUUID());
  const jobsRef = useRef(jobs);
  const detailRef = useRef(detail);
  const activeNavRef = useRef(activeNav);
  const pollingRequests = useRef(new Set<string>());
  jobsRef.current = jobs;
  detailRef.current = detail;
  activeNavRef.current = activeNav;

  async function openProject(projectId: string, section = 'Story & script') {
    try {
      const result = await api<ProjectDetail>(`/projects/${projectId}`);
      setDetail(result);
      setActiveNav(section);
      setJobs((current) => {
        const next = { ...current };
        result.jobs.forEach((job) => { next[job.id] = { ...job, projectId }; });
        return next;
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open project.'); }
  }

  async function refresh() {
    try {
      const result = await api<{ projects: Project[] }>('/projects');
      setProjects(result.projects);
      setJobs((current) => {
        const next = { ...current };
        result.projects.forEach((project) => {
          if (project.jobId && project.jobStatus) next[project.jobId] = { id: project.jobId, projectId: project.id, status: project.jobStatus, stage: project.stage || project.status, progress: Number(project.progress || 0), error: project.jobError };
        });
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load projects.');
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const active = Object.values(jobsRef.current).filter((job) => job.status === 'queued' || job.status === 'processing');
    if (!active.length) return;
    const timer = window.setInterval(() => {
      Object.values(jobsRef.current)
        .filter((job) => job.status === 'queued' || job.status === 'processing')
        .forEach((job) => {
          if (pollingRequests.current.has(job.id)) return;
          pollingRequests.current.add(job.id);
          void (async () => {
            try {
              const result = await api<{ job: Job }>(`/jobs/${job.id}`);
              jobsRef.current = { ...jobsRef.current, [job.id]: result.job };
              setJobs((current) => ({ ...current, [job.id]: result.job }));
              setDetail((current) => current?.project.id === job.projectId ? { ...current, jobs: current.jobs.map((item) => item.id === job.id ? { ...item, ...result.job } : item) } : current);
              if (result.job.status === 'complete' || result.job.status === 'failed') {
                void refresh();
                if (detailRef.current?.project.id === job.projectId) void openProject(job.projectId, activeNavRef.current);
              }
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'Could not refresh production status.');
            } finally {
              pollingRequests.current.delete(job.id);
            }
          })();
        });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  async function createProduction(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    const requestedDuration = duration === 0 ? Number(customDuration) * 60 : duration;
    try {
      if (!Number.isInteger(requestedDuration) || requestedDuration < 60 || requestedDuration > 1200) throw new Error('Custom duration must be from 1 to 20 minutes.');
      const result = await api<{ project: Project; job: Job }>('/projects/produce', {
        method: 'POST', headers: { 'idempotency-key': productionKey.current }, body: JSON.stringify({ title: title.trim(), language, durationSeconds: requestedDuration }),
      });
      setProjects((current) => [result.project, ...current.filter((project) => project.id !== result.project.id)]);
      setJobs((current) => ({ ...current, [result.job.id]: result.job }));
      productionKey.current = crypto.randomUUID();
      setTitle(''); setNotice('Production queued. Assets will only be marked complete after MP4 validation.');
      setActiveNav('Drama projects');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start production.');
    } finally { setBusy(false); }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Permanently delete “${project.title}” and its production data?`)) return;
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (detail?.project.id === project.id) { setDetail(null); setActiveNav('Drama projects'); }
      setNotice(`Deleted “${project.title}”.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Delete failed.'); }
  }

  async function duplicateProject(project: Project) {
    try {
      const result = await api<{ project: Project }>(`/projects/${project.id}/duplicate`, { method: 'POST' });
      setProjects((current) => [result.project, ...current]);
      setNotice(`Created “${result.project.title}”.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not duplicate project.'); }
  }

  async function renameProject(project: Project) {
    const nextTitle = window.prompt('Project title', project.title)?.trim();
    if (!nextTitle || nextTitle === project.title) return;
    try {
      const result = await api<{ project: Project }>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ title: nextTitle }) });
      setProjects((current) => current.map((item) => item.id === project.id ? result.project : item));
      if (detail?.project.id === project.id) setDetail((current) => current ? { ...current, project: result.project } : current);
      setNotice('Project renamed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Rename failed.'); }
  }

  async function resumeJob(job: Job) {
    try {
      const result = await api<{ job: Job }>(`/jobs/${job.id}/resume`, { method: 'POST' });
      setJobs((current) => ({ ...current, [job.id]: result.job }));
      void openProject(job.projectId, activeNav);
      setNotice('Unfinished stages have been queued for resume.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not resume production.'); }
  }

  const runningJobs = Object.values(jobs).filter((job) => job.status === 'queued' || job.status === 'processing');
  const completeCount = projects.filter((project) => project.status === 'complete').length;
  const showProjects = activeNav === 'Overview' || activeNav === 'Drama projects';
  const showWorkspace = activeNav !== 'Overview' && activeNav !== 'Drama projects' && Boolean(detail);

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => { setActiveNav('Overview'); setDetail(null); }} aria-label="Ghazali AI home">
          <span className="brand-mark">G</span><span className="brand-copy">GHAZALI <i>AI</i><small>DRAMA STUDIO</small></span>
        </a>
        <button className="new-project" onClick={() => { setActiveNav('Overview'); document.getElementById('production-title')?.focus(); }}>＋ <span>New production</span></button>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Workspace">
          {navItems.map((item, index) => <button key={item} className={`nav-item ${activeNav === item ? 'selected' : ''}`} onClick={() => { setActiveNav(item); if (item === 'Overview') setDetail(null); else if (item !== 'Drama projects' && projects[0]) void openProject(detail?.project.id || projects[0].id, item); }}><span className="nav-icon">{['⌂', '▧', '≡', '♙', '▦', '▧', '◖', '♫', '⌖', '▤', '▷', '◴', '⚙'][index]}</span>{item}{item === 'Drama projects' && <b>{projects.length}</b>}</button>)}
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> Provider configuration required <small>Private workspace</small></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="crumb">Studio <span>/</span> {activeNav}</div><div className="account"><span className="account-avatar">G</span><span>My workspace</span><span className="chevron">⌄</span></div></header>
        <div className="page-content">
          <section className="intro-row"><div><div className="eyebrow"><span className="eyebrow-line" /> AI DRAMA & STORYBOARD STUDIO</div><h1>{activeNav === 'Overview' ? <>Make a story<br /><em>worth watching.</em></> : activeNav}</h1><p className="intro-copy">From a single idea to a fully voiced, cinematic drama.</p></div><div className="date-stamp"><span>YOUR STUDIO</span><strong>01 <i>/</i> 05</strong><small>APPROVED LANGUAGES</small></div></section>

          {error && <div className="alert error" role="alert"><span>!</span>{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {notice && <div className="alert success" role="status"><span>✓</span>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}

          {activeNav === 'Overview' && <section className="workbench" aria-labelledby="production-heading">
            <div className="workbench-heading"><div><div className="section-index">01 <span>—</span> NEW PRODUCTION</div><h2 id="production-heading">Start with an idea.</h2></div><span className="secure-label"><span className="status-dot" /> AI providers connect securely</span></div>
            <form onSubmit={createProduction}>
              <label className="field-label" htmlFor="production-title">DRAMA TITLE <span>or start from a blank page</span></label>
              <input id="production-title" className="title-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} placeholder="A title, a feeling, a first line…" required />
              <div className="form-grid">
                <div><label className="field-label" htmlFor="duration">FINAL DURATION</label><select id="duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{durations.map((seconds) => <option key={seconds} value={seconds}>{durationLabel(seconds)}</option>)}<option value={0}>Custom duration</option></select>{duration === 0 && <input className="custom-duration" type="number" min="1" max="20" value={customDuration} onChange={(event) => setCustomDuration(event.target.value)} placeholder="Minutes (1–20)" aria-label="Custom duration in minutes" />}</div>
                <div><label className="field-label" htmlFor="language">PRODUCTION LANGUAGE</label><select id="language" value={language} onChange={(event) => setLanguage(event.target.value as ApprovedLanguage)}>{APPROVED_LANGUAGES.map((option) => <option key={option}>{option}</option>)}</select></div>
                <div className="voice-note"><span className="voice-note-icon">◖</span><span><b>Voice selected automatically</b><small>Provider compatibility is checked before production</small></span><span className="voice-chevron">⌄</span></div>
              </div>
              <div className="submit-row"><div className="one-click"><span>✦</span> STORY · SCENES · VOICE · MUSIC · VIDEO</div><button className="create-button" type="submit" disabled={busy || runningJobs.length > 0}>{busy ? <><span className="spinner" /> QUEUING…</> : runningJobs.length > 0 ? <>PRODUCTION IN PROGRESS</> : <>CREATE COMPLETE DRAMA <span>↗</span></>}</button></div>
            </form>
            <div className="workflow-strip"><span>ONE CLICK</span>{['Story', 'Storyboard', 'Voice', 'Music', 'Render', 'Validate'].map((step, index) => <div key={step} className="workflow-step"><i>{String(index + 1).padStart(2, '0')}</i>{step}</div>)}</div>
          </section>}

          {runningJobs.length > 0 && <section className="production-progress"><div className="section-index">IN PRODUCTION</div>{runningJobs.map((job) => <div className="job-line" key={job.id}><div><strong>{projects.find((project) => project.id === job.projectId)?.title || 'Untitled production'}</strong><span>{job.stage}</span></div><div className="progress-track"><i style={{ width: `${Math.min(job.progress, 99)}%` }} /></div><small>{Math.min(job.progress, 99)}%</small></div>)}</section>}

          {showProjects && <section className="projects-section"><div className="projects-heading"><div><div className="section-index">YOUR WORKSPACE</div><h2>{activeNav === 'Overview' ? 'Recent productions' : 'Drama projects'} <span>{projects.length.toString().padStart(2, '0')}</span></h2></div><div className="project-summary"><span>{completeCount.toString().padStart(2, '0')}</span> READY TO DOWNLOAD</div></div>
            {projects.length === 0 ? <div className="empty-state"><div className="empty-glyph">▱</div><strong>Your next story starts here.</strong><p>Productions and drafts will appear here as they are saved.</p></div> : <div className="project-list">{projects.map((project) => {
              const job = Object.values(jobs).find((item) => item.projectId === project.id);
              return <article className="project-row" key={project.id}><div className="project-art"><span>{project.title.slice(0, 1).toUpperCase()}</span></div><div className="project-info"><button className="project-open" onClick={() => void openProject(project.id)}>{project.title}</button><span>{project.language} <i>·</i> {durationLabel(project.durationSeconds)} <i>·</i> Updated {new Date(project.updatedAt).toLocaleDateString()}</span></div><div className={`project-status ${project.status}`}>{project.status === 'complete' ? 'READY TO DOWNLOAD' : project.status === 'failed' ? 'NEEDS ATTENTION' : job?.stage || project.stage || project.status}</div><div className="project-actions">{job?.status === 'failed' && <button className="icon-button" onClick={() => void resumeJob(job)} title="Resume unfinished production" aria-label="Resume unfinished production">↻</button>}{project.status === 'complete' && <a className="icon-button" href={`/api/projects/${project.id}/download`} title="Download validated MP4" aria-label="Download validated MP4">↓</a>}<button className="icon-button" onClick={() => void renameProject(project)} title="Rename project" aria-label="Rename project">✎</button><button className="icon-button" onClick={() => void duplicateProject(project)} title="Duplicate project" aria-label="Duplicate project">⧉</button><button className="icon-button danger-action" onClick={() => void deleteProject(project)} title="Delete project" aria-label="Delete project">×</button></div></article>;
            })}</div>}
          </section>}
          {showWorkspace && detail && <ProjectWorkspace detail={detail} projects={projects} section={activeNav} onSelect={(id) => void openProject(id, activeNav)} onResume={(jobId) => { const job = jobs[jobId]; if (job) void resumeJob(job); }} onRename={() => void renameProject(detail.project)} onDuplicate={() => void duplicateProject(detail.project)} onDelete={() => void deleteProject(detail.project)} />}
          {!showProjects && !detail && <div className="empty-state"><div className="empty-glyph">▱</div><strong>Choose a project to open this studio.</strong><p>Create a production or select a project from Drama projects.</p></div>}
          <footer className="page-footer"><span>GHAZALI AI <i>·</i> PRODUCTION STUDIO</span><span>AI GENERATED MEDIA IS VALIDATED BEFORE DELIVERY</span></footer>
        </div>
      </main>
    </div>
  );
}