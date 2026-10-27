import React, { useState, useEffect, useRef } from 'react'
import { GitBranch, GitCommit, FileCode2, ChevronRight, X, Plus, FolderOpen, BookOpen, AlertCircle } from 'lucide-react'

const syntaxAwareExtensions = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'html', 'md', 'yaml',
  'yml', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'rs', 'go', 'rb', 'php', 'sh',
])

function getFileExtension(filename) {
  const parts = String(filename || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

function isBalanced(text) {
  const pairs = { '{': '}', '[': ']', '(': ')' }
  const openers = Object.keys(pairs)
  const closers = Object.values(pairs)
  const stack = []

  for (const ch of text) {
    if (openers.includes(ch)) stack.push(ch)
    else if (closers.includes(ch)) {
      const last = stack.pop()
      if (!last || pairs[last] !== ch) return false
    }
  }

  return stack.length === 0
}

function scoreSyntaxShape(text, filename) {
  const ext = getFileExtension(filename)
  const trimmed = text.trim()
  let score = 0

  if (!trimmed) return 0
  if (syntaxAwareExtensions.has(ext)) score += 1
  if (isBalanced(trimmed)) score += 2
  if (/\b(function|class|const|let|var|export|import|return|if|for|while|switch|def|public|private|type|interface)\b/.test(trimmed)) score += 1.5
  if (/[;{}\]]$/.test(trimmed)) score += 0.5
  if (ext === 'json' && /^[{\[]/.test(trimmed)) score += 1
  if (ext === 'md' && /^#{1,6}\s/.test(trimmed)) score += 0.5

  return score + trimmed.split('\n').length * 0.05
}

function buildSmartMergeDraft(filename, currentLines, incomingLines) {
  const currentText = currentLines.join('\n').trimEnd()
  const incomingText = incomingLines.join('\n').trimEnd()

  if (!currentText) return incomingText
  if (!incomingText) return currentText
  if (currentText === incomingText) return currentText

  const currentScore = scoreSyntaxShape(currentText, filename)
  const incomingScore = scoreSyntaxShape(incomingText, filename)

  if (Math.abs(currentScore - incomingScore) >= 1.5) {
    return currentScore >= incomingScore ? currentText : incomingText
  }

  const merged = []
  const seen = new Set()
  const appendLine = (line) => {
    const normalized = line.trim()
    if (!normalized) {
      if (merged.length && merged[merged.length - 1] !== '') merged.push('')
      return
    }
    if (!seen.has(normalized)) {
      merged.push(line)
      seen.add(normalized)
    }
  }

  currentLines.forEach(appendLine)
  if (merged.length && incomingLines.some((line) => line.trim() && !seen.has(line.trim()))) merged.push('')
  incomingLines.forEach(appendLine)

  return merged.join('\n') || currentText || incomingText
}

function summarizeHunk(hunk) {
  return hunk.lines.reduce((acc, line) => {
    if (line.t === 'add') acc.additions++
    else if (line.t === 'del') acc.deletions++
    else acc.context++
    return acc
  }, { additions: 0, deletions: 0, context: 0 })
}

export default function App() {
  const [view, setView] = useState('welcome')
  const [serverPort, setServerPort] = useState(5005)
  const [activeTab, setActiveTab] = useState('commits')
  
  const [state, setState] = useState({ commits: [], branches: {}, head: '', files: [], repoName: '', status: null })
  const [connected, setConnected] = useState(false)

  // Modals for File Content / Diffs
  const [activeFile, setActiveFile] = useState(null)
  const [activeCommitDiff, setActiveCommitDiff] = useState(null)
  const [activeConflictBlocks, setActiveConflictBlocks] = useState(null)

  // Branch creation
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  // Commit flow
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)

  // Quick Wins: Features
  const [recentRepos, setRecentRepos] = useState(() => {
    try { return JSON.parse(localStorage.getItem('gitbro_recent_repos') || '[]'); } 
    catch(e) { return []; }
  })
  const [commitSearch, setCommitSearch] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const [toastMsg, setToastMsg] = useState(null)
  const [showBlame, setShowBlame] = useState(false)
  const [activeBlame, setActiveBlame] = useState(null)
  const [blameLoading, setBlameLoading] = useState(false)
  const [browserRepoMode, setBrowserRepoMode] = useState(false)

  const browserPickerRef = useRef(null)

  const showToast = (msg) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 3000)
  }

  const resetRepoState = (repoName) => {
    setState({
      commits: [],
      branches: {},
      head: '',
      files: [],
      repoName: repoName || '',
      status: { toCommit: [], notStaged: [], untracked: [] },
    })
    setConnected(false)
    setServerPort(0)
    setActiveTab('commits')
    setActiveFile(null)
    setActiveCommitDiff(null)
    setActiveConflictBlocks(null)
    setShowBlame(false)
    setActiveBlame(null)
  }



  const SERVER = `http://localhost:${serverPort}`

  const connectToRepo = (res) => {
    setServerPort(res.port)
    setView('dashboard')
    
    // Save to recents
    const newRecents = [res.path, ...recentRepos.filter(p => p !== res.path)].slice(0, 5)
    setRecentRepos(newRecents)
    localStorage.setItem('gitbro_recent_repos', JSON.stringify(newRecents))
  }

  const handleSelectRepo = async () => {
    if (window.gitbro) {
      const res = await window.gitbro.selectRepo()
      if (res && res.error) {
        showToast(res.error)
      } else if (res && !res.canceled && res.success) {
        connectToRepo(res)
      }
    } else {
      browserPickerRef.current?.click()
    }
  }

  const handleBrowserFolderSelected = (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''

    if (!files.length) return

    const rootName = (files[0].webkitRelativePath || files[0].name || 'Selected Repository').split('/')[0]
    resetRepoState(rootName)
    setBrowserRepoMode(true)
    setView('dashboard')
    showToast(`Selected ${rootName} from your computer`)
  }

  const handleOpenRecent = async (path) => {
    if (window.gitbro) {
      const res = await window.gitbro.openRepo(path)
      if (res && res.error) {
        showToast(res.error)
      } else if (res && res.success) {
        connectToRepo(res)
      }
    } else {
      showToast('Recent repositories require the Electron desktop app.')
    }
  }

  const loadData = async () => {
    if (browserRepoMode || serverPort === 0 || !window.gitbro) return
    try {
      const infoRes = await fetch(`${SERVER}/api/info`)
      const commitsRes = await fetch(`${SERVER}/api/commits`)
      const statusRes = await fetch(`${SERVER}/api/status`)
      if (infoRes.ok && commitsRes.ok && statusRes.ok) {
        const info = await infoRes.json()
        const commits = await commitsRes.json()
        const statusData = await statusRes.json()
        setState({ ...state, ...info, commits, status: statusData })
        if (!connected) {
          setConnected(true)
        }
      }
    } catch (e) {
      if (connected) setConnected(false)
    }
  }

  useEffect(() => {
    if (view !== 'dashboard') return;
    loadData()
    const interval = setInterval(loadData, 4000)
    return () => clearInterval(interval)
  }, [view, connected, serverPort, browserRepoMode])



  const runAction = async (cmd) => {
    try {
      const res = await fetch(`${SERVER}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd })
      })
      return await res.json()
    } catch (err) {
      return { error: 'Connection error' }
    }
  }

  const handleSwitchBranch = async (branch) => {
    if (branch === state.head) return;
    const res = await runAction(`checkout ${branch}`)
    if (res.error) showToast(`Error checking out: ${res.error}`)
    else showToast(`Switched to branch ${branch}`)
    loadData()
    setActiveTab('code')
  }

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    const res = await runAction(`branch ${newBranchName.trim()}`)
    if (res.error) showToast(`Error creating branch: ${res.error}`)
    else showToast(`Created branch ${newBranchName.trim()}`)
    setNewBranchName('')
    setShowNewBranch(false)
    loadData()
  }

  const handleOpenCommitDialog = () => {
    if (!state.status) return
    const hasChanges = state.status.toCommit.length > 0 || state.status.notStaged.length > 0 || state.status.untracked.length > 0
    if (!hasChanges) {
      showToast('Nothing to commit')
      return
    }
    setCommitMessage('')
    setShowCommitDialog(true)
  }

  const handleCreateCommit = async () => {
    const message = commitMessage.trim()
    if (!message) {
      showToast('Enter a commit message first')
      return
    }

    setIsCommitting(true)
    try {
      const res = await fetch(`${SERVER}/api/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, stageAll: true })
      })
      const data = await res.json()
      if (data.error) {
        showToast(`Commit failed: ${data.error}`)
        return
      }

      showToast(`Committed: ${message}`)
      setShowCommitDialog(false)
      setCommitMessage('')
      await loadData()
      setActiveTab('commits')
    } catch (e) {
      showToast('Commit failed: connection error')
    } finally {
      setIsCommitting(false)
    }
  }

  const handleOpenFile = async (file) => {
    try {
      const res = await fetch(`${SERVER}/api/blob/${file.sha}`)
      const data = await res.json()
      setActiveFile({ ...file, content: data.content })
      setShowBlame(false)
      setActiveBlame(null)
      setBlameLoading(false)
    } catch (e) {
      showToast("Error fetching file content via API")
    }
  }

  const loadBlame = async (filePath) => {
    if (!filePath) return
    setBlameLoading(true)
    try {
      const res = await fetch(`${SERVER}/api/blame/${encodeURIComponent(filePath)}`)
      const data = await res.json()
      setActiveBlame(Array.isArray(data.lines) ? data.lines : [])
    } catch (e) {
      setActiveBlame([])
      showToast('Blame data is unavailable')
    } finally {
      setBlameLoading(false)
    }
  }

  const handleToggleBlame = async () => {
    if (!activeFile || activeFile.isConflict) return
    const next = !showBlame
    setShowBlame(next)
    if (next && !activeBlame) {
      await loadBlame(activeFile.path)
    }
  }

  const handleResolveConflict = async (filename) => {
    try {
      const res = await fetch(`${SERVER}/api/worktree/${encodeURIComponent(filename)}`);
      const data = await res.json();
      
      const lines = (data.content || '').split('\n');
      const blocks = [];
      let currentBlock = { id: 0, type: 'normal', lines: [] };
      let inInc = false;
      let id = 1;

      lines.forEach(line => {
        if (line.startsWith('<<<<<<< HEAD')) {
          blocks.push(currentBlock);
          currentBlock = { id: id++, type: 'conflict', currentLines: [], incomingLines: [], resolutionChoice: 'smart', draft: '' };
          inInc = false;
        } else if (line.startsWith('=======')) {
          inInc = true;
        } else if (line.startsWith('>>>>>>>')) {
          blocks.push(currentBlock);
          currentBlock = { id: id++, type: 'normal', lines: [] };
          inInc = false;
        } else {
          if (currentBlock.type === 'normal') currentBlock.lines.push(line);
          else if (inInc) currentBlock.incomingLines.push(line);
          else currentBlock.currentLines.push(line);
        }
      });
      blocks.push(currentBlock);

      const conflictBlocks = blocks.filter(b => b.type === 'conflict' || b.lines.length > 0).map((block) => {
        if (block.type !== 'conflict') return block;
        return {
          ...block,
          draft: buildSmartMergeDraft(filename, block.currentLines, block.incomingLines),
        }
      });
      
      setActiveConflictBlocks(conflictBlocks);
      setActiveFile({ path: filename, isConflict: true, content: data.content });
      setShowBlame(false)
      setActiveBlame(null)
      setActiveTab('code');
    } catch(e) { showToast('Failed to read conflicted file'); }
  }

  const handleAcceptBlock = (id, choice) => {
    setActiveConflictBlocks(blocks => blocks.map(b => {
      if (b.id !== id) return b
      if (b.type !== 'conflict') return b
      const nextDraft = choice === 'current'
        ? b.currentLines.join('\n')
        : choice === 'incoming'
          ? b.incomingLines.join('\n')
          : choice === 'both'
            ? [b.currentLines.join('\n'), b.incomingLines.join('\n')].filter(Boolean).join('\n\n')
            : buildSmartMergeDraft(activeFile?.path || '', b.currentLines, b.incomingLines)
      return { ...b, resolutionChoice: choice, draft: nextDraft }
    }));
  }

  const handleChangeBlockDraft = (id, draft) => {
    setActiveConflictBlocks(blocks => blocks.map(b => b.id === id ? { ...b, draft } : b));
  }

  const handleSaveResolution = async () => {
    if (activeConflictBlocks.some(b => b.type === 'conflict' && !b.draft?.trim())) {
      showToast('Please resolve all conflict blocks first.');
      return;
    }
    
    const finalLines = [];
    activeConflictBlocks.forEach(b => {
      if (b.type === 'normal') finalLines.push(...b.lines);
      else if (b.type === 'conflict') {
        finalLines.push(...String(b.draft || '').split('\n'));
      }
    });
    
    const content = finalLines.join('\n');
    await fetch(`${SERVER}/api/worktree/${encodeURIComponent(activeFile.path)}`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    
    showToast('Conflict resolved and saved!');
    setActiveFile(null);
    setActiveConflictBlocks(null);
    setShowBlame(false)
    setActiveBlame(null)
    await runAction(`add ${activeFile.path}`);
    loadData();
    setActiveTab('changes');
  }

  const handleOpenCommitDiff = async (commit) => {
    try {
      const hres = await fetch(`${SERVER}/api/commitdiff/${commit.sha}`)
      if (!hres.ok) throw new Error("API failed");
      const data = await hres.json()
      setActiveCommitDiff({ ...commit, diffData: data })
    } catch (e) {
      const res = await runAction(`log`)
      alert("Diff loaded via log since commitdiff API failed (see terminal)")
    }
  }

  const latestTreeItems = (() => {
    const folders = new Set()
    const files = [...state.files].sort((a, b) => a.path.localeCompare(b.path))
    files.forEach((file) => {
      const parts = file.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join('/'))
      }
    })
    return { folders: [...folders].sort(), files }
  })()

  const visibleTreeFiles = latestTreeItems.files.filter((file) => {
    const query = fileSearch.trim().toLowerCase()
    if (!query) return true
    return file.path.toLowerCase().includes(query) || file.sha.toLowerCase().includes(query)
  })

  if (view === 'welcome') {
    return (
      <div className="flex flex-col h-screen w-full bg-slate-50 text-slate-800 font-sans items-center justify-center relative">
        <div className="h-4 w-full bg-slate-50 shrink-0 absolute top-0 left-0 z-50 pointer-events-none" style={{WebkitAppRegion: "drag"}}></div>
        <div className="text-center max-w-md animation-fade-in bg-white p-10 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200">
          <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm border border-indigo-100">
            <GitBranch size={40} className="text-indigo-600" />
          </div>
          <h1 className="text-3xl font-extrabold text-slate-900 mb-3 tracking-tight">GitBro Desktop</h1>
          <p className="text-sm text-slate-500 mb-10 leading-relaxed font-medium">Please select a local repository from your computer to start managing it natively.</p>
          <button onClick={handleSelectRepo} className="bg-indigo-600 text-white px-6 py-3.5 rounded-xl shadow-md hover:bg-indigo-500 hover:shadow-lg transition-all flex items-center justify-center gap-3 w-full font-bold text-sm">
            <FolderOpen size={18} />
            Open Local Repository
          </button>
          <input
            ref={browserPickerRef}
            type="file"
            webkitdirectory="true"
            directory="true"
            multiple
            className="hidden"
            onChange={handleBrowserFolderSelected}
          />
          
          {recentRepos.length > 0 && (
            <div className="mt-8 text-left">
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Recent Repositories</h3>
              <div className="space-y-1.5">
                {recentRepos.map(path => (
                  <button key={path} onClick={() => handleOpenRecent(path)} className="w-full text-left px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200 transition-colors truncate shadow-sm">
                    {path}
                  </button>
                ))}
              </div>
            </div>
          )}

          {connected && (
            <button onClick={() => setView('dashboard')} className="mt-4 text-sm font-bold text-slate-500 hover:text-slate-800 transition-colors">
              Cancel & Go Back to {state.repoName}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 text-slate-800 font-sans pt-8">
      <div className="h-4 w-full bg-white shrink-0 absolute top-0 left-0 z-50 pointer-events-none" style={{WebkitAppRegion: "drag"}}></div>
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - Light Theme */}
        <div className="w-64 bg-slate-100 border-r border-slate-200 flex flex-col shrink-0 shadow-[2px_0_8px_rgba(0,0,0,0.02)] z-10">
          <div className="p-5 border-b border-slate-200 bg-white">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 flex items-center justify-between">
              Repository
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]' : 'bg-red-400'}`}></span>
            </div>
            <div className="font-mono text-lg font-bold text-slate-800 truncate" title={state.repoName}>
              {state.repoName || 'Not Connected'}
            </div>
            <div className="text-xs font-mono font-medium text-indigo-600 mt-1.5 flex items-center gap-1.5 bg-indigo-50 w-max px-2 py-0.5 rounded border border-indigo-100">
              <GitBranch size={14} /> <span>{state.head || 'No branch'}</span>
            </div>
            <button onClick={() => setView('welcome')} className="mt-3 w-full text-[10px] font-bold text-slate-500 border border-slate-200 rounded py-1 hover:bg-slate-50 transition-colors uppercase tracking-widest">
              Switch Repo
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            <div>
              <div className="flex items-center justify-between px-2 mb-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Branches</span>
                <button onClick={() => setShowNewBranch(!showNewBranch)} className="text-slate-400 hover:text-indigo-600 transition-colors p-1 rounded hover:bg-indigo-50">
                  <Plus size={14} />
                </button>
              </div>

              {showNewBranch && (
                <div className="mb-2 px-2 pb-2">
                  <input 
                    type="text" 
                    placeholder="Branch name..."
                    value={newBranchName}
                    onChange={e => setNewBranchName(e.target.value)}
                    className="w-full text-xs p-1.5 border border-slate-300 rounded shadow-sm focus:outline-none focus:border-indigo-500 font-mono text-slate-700"
                    onKeyDown={e => e.key === 'Enter' && handleCreateBranch()}
                  />
                  <div className="flex gap-1 mt-1 justify-end">
                    <button onClick={() => setShowNewBranch(false)} className="text-[10px] text-slate-500 hover:text-slate-800 px-2 py-0.5">Cancel</button>
                    <button onClick={handleCreateBranch} className="text-[10px] font-bold text-white bg-indigo-600 rounded px-2 py-0.5 hover:bg-indigo-700">Create</button>
                  </div>
                </div>
              )}

              <div className="space-y-0.5">
                {Object.keys(state.branches).map(b => {
                  const isHead = b === state.head;
                  return (
                    <div 
                      key={b} 
                      onClick={() => handleSwitchBranch(b)}
                      className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md cursor-pointer text-sm font-medium transition-all ${isHead ? 'bg-white shadow-sm border border-slate-200 text-indigo-700' : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900 border border-transparent'}`}
                    >
                      <GitBranch size={14} className={isHead ? 'text-indigo-500' : 'text-slate-400'} /> 
                      <span className="truncate">{b}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col bg-slate-50 overflow-hidden relative">
          
          {/* Tabs - Light Theme */}
          <div className="flex items-end justify-between border-b border-slate-200 px-4 pt-4 bg-white shrink-0 z-10 shadow-sm relative">
            <div className="flex gap-1">
              {[
                { id: 'commits', icon: <GitCommit size={15} />, label: 'Commits', count: state.commits.length },
                { id: 'code', icon: <FileCode2 size={15} />, label: 'Code' },
                { id: 'changes', icon: <Plus size={15} />, label: 'Changes', count: state.status ? (state.status.toCommit.length + state.status.notStaged.length + state.status.untracked.length) : 0 },

                { id: 'help', icon: <BookOpen size={15} />, label: 'Help / Commands' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all block ${activeTab === tab.id ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50 rounded-t-lg relative top-[1px]' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-t-lg'}`}
                >
                  {tab.icon} {tab.label}
                  {tab.count !== undefined && <span className={`ml-1.5 py-[2px] px-2 rounded-full text-[10px] font-bold ${activeTab === tab.id ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{tab.count}</span>}
                </button>
              ))}
            </div>
            

          </div>

          {/* Tab Content Areas */}
          <div className="flex-1 overflow-y-auto p-6 relative">
            {browserRepoMode && (
              <div className="max-w-4xl mx-auto mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 shadow-sm">
                Browser mode selected a local folder. Full Git operations still require the Electron app or a running GitBro server.
              </div>
            )}
            
            {/* COMMITS TAB */}
            {activeTab === 'commits' && (() => {
              const filteredCommits = state.commits.filter(c => 
                c.message.toLowerCase().includes(commitSearch.toLowerCase()) || 
                c.author.toLowerCase().includes(commitSearch.toLowerCase()) ||
                c.sha.startsWith(commitSearch)
              );

              // SVG Graph Topology
              const ROW_HT = 100; // 88px row + 12px gap
              const ROW_CENTER = 44; 
              const TRACK_W = 16;
              const START_X = 24;

              const branchColors = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#3b82f6', '#8b5cf6', '#14b8a6', '#f43f5e'];
              
              const nodes = [];
              const lines = [];
              const commitTracks = {}; 
              const activePaths = [];

              if (commitSearch === '') {
                filteredCommits.forEach((c, i) => {
                  let trackIdx = activePaths.indexOf(c.sha);
                  if (trackIdx === -1) {
                    trackIdx = activePaths.findIndex(t => !t);
                    if (trackIdx === -1) trackIdx = activePaths.length;
                    activePaths[trackIdx] = c.sha;
                  }
                  
                  const x = START_X + trackIdx * TRACK_W;
                  const y = i * ROW_HT + ROW_CENTER;
                  const color = branchColors[trackIdx % branchColors.length];
                  
                  nodes.push({ sha: c.sha, x, y, color, trackIdx });
                  commitTracks[c.sha] = { x, y, color, trackIdx };

                  if (c.parents.length > 0) {
                    activePaths[trackIdx] = c.parents[0];
                    for (let j = 1; j < c.parents.length; j++) {
                      let emptyIdx = activePaths.findIndex(t => !t);
                      if (emptyIdx === -1) emptyIdx = activePaths.length;
                      activePaths[emptyIdx] = c.parents[j];
                    }
                  } else {
                    activePaths[trackIdx] = null;
                  }
                });

                filteredCommits.forEach(c => {
                  const node = commitTracks[c.sha];
                  c.parents.forEach((pSha, pIdx) => {
                    const pNode = commitTracks[pSha];
                    if (pNode) {
                      lines.push({
                        x1: node.x, y1: node.y + 6,
                        x2: pNode.x, y2: pNode.y - 6,
                        color: pIdx === 0 ? node.color : pNode.color,
                        isMerge: pIdx > 0
                      });
                    }
                  });
                });
              }

              return (
              <div className="max-w-4xl mx-auto animation-fade-in pb-10">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-xl font-bold text-slate-800">History</h2>
                  <input 
                    type="text" 
                    placeholder="Search commits..." 
                    value={commitSearch}
                    onChange={e => setCommitSearch(e.target.value)}
                    className="text-sm px-3 py-1.5 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:border-indigo-500 w-64 text-slate-700"
                  />
                </div>
                
                {/* Active Commit Diff Viewer Modal overlay mapping */}
                {activeCommitDiff ? (
                  <div className="bg-white border border-slate-300 rounded-xl shadow-lg mb-6 overflow-hidden">
                    <div className="bg-slate-100 border-b border-slate-200 px-4 py-3 flex justify-between items-center">
                      <div>
                        <span className="font-bold text-slate-800 block text-sm">{activeCommitDiff.message}</span>
                        <span className="text-xs text-slate-500 font-mono">{activeCommitDiff.sha}</span>
                      </div>
                      <button onClick={() => setActiveCommitDiff(null)} className="p-1.5 bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 text-slate-600">
                        <X size={16} />
                      </button>
                    </div>
                    <div className="p-0 max-h-[60vh] overflow-y-auto">
                      {activeCommitDiff.diffData?.files?.map((dfile, i) => (
                        <div key={i} className="border-b border-slate-200 last:border-b-0">
                          <div className="bg-slate-50 py-2 px-4 text-xs font-mono font-bold border-b border-slate-200 text-slate-700 flex items-center justify-between gap-3">
                            <div>
                              {dfile.path} {dfile.isNew && <span className="ml-2 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 rounded">NEW</span>} {dfile.isDeleted && <span className="ml-2 text-[10px] bg-red-100 text-red-700 px-1.5 rounded">DELETED</span>}
                            </div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                              {(() => {
                                const counts = (dfile.hunks || []).reduce((acc, hunk) => {
                                  const stats = summarizeHunk(hunk)
                                  acc.additions += stats.additions
                                  acc.deletions += stats.deletions
                                  return acc
                                }, { additions: 0, deletions: 0 })
                                return `+${counts.additions} -${counts.deletions}`
                              })()}
                            </div>
                          </div>
                          <div className="font-mono text-xs overflow-x-auto leading-relaxed bg-white">
                            {dfile.hunks?.map((hunk, hi) => (
                              <div key={hi} className="border-t border-slate-100">
                                <div className="bg-indigo-50 text-indigo-500 px-4 py-1 select-none font-bold italic border-b border-indigo-100">
                                  @@ -{hunk.oldStart},{hunk.lines.filter((line) => line.t !== 'add').length} +{hunk.newStart},{hunk.lines.filter((line) => line.t !== 'del').length} @@
                                </div>
                                <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem_minmax(0,1fr)]">
                                  {(() => {
                                    let oldLine = hunk.oldStart
                                    let newLine = hunk.newStart
                                    return hunk.lines?.map((line, li) => {
                                      const isAdd = line.t === 'add'
                                      const isDel = line.t === 'del'
                                      const isEq = line.t === 'eq'
                                      const rowClass = isAdd
                                        ? 'bg-emerald-50 text-emerald-900'
                                        : isDel
                                          ? 'bg-red-50 text-red-900'
                                          : 'bg-white text-slate-700'
                                      const oldNum = isAdd ? '' : oldLine
                                      const newNum = isDel ? '' : newLine
                                      const oldText = isAdd ? '' : line.l
                                      const newText = isDel ? '' : line.l

                                      if (!isAdd) oldLine++
                                      if (!isDel) newLine++

                                      return (
                                        <React.Fragment key={li}>
                                          <div className={`px-2 py-0.5 text-right text-slate-400 border-r border-slate-100 ${rowClass}`}>{oldNum}</div>
                                          <div className={`px-3 py-0.5 whitespace-pre-wrap break-words border-r border-slate-100 ${rowClass}`}>{oldText || ' '}</div>
                                          <div className={`px-2 py-0.5 text-right text-slate-400 border-r border-slate-100 ${rowClass}`}>{newNum}</div>
                                          <div className={`px-3 py-0.5 whitespace-pre-wrap break-words ${rowClass}`}>{newText || ' '}</div>
                                        </React.Fragment>
                                      )
                                    })
                                  })()}
                                </div>
                              </div>
                            ))}
                            {(!dfile.hunks || dfile.hunks.length === 0) && <div className="p-4 text-slate-400 italic">No visible diff chunks</div>}
                          </div>
                        </div>
                      ))}
                      {(!activeCommitDiff.diffData?.files || activeCommitDiff.diffData.files.length === 0) && (
                        <div className="p-8 text-center text-slate-500">No file changes detected in this commit.</div>
                      )}
                    </div>
                  </div>
                ) : null}

                <div className="flex items-stretch relative">
                  {commitSearch === '' && nodes.length > 0 && (
                    <div className="shrink-0 relative w-16" style={{ width: `${Math.max(48, nodes.reduce((m, n) => Math.max(m, n.x), 0) + 24)}px` }}>
                      <svg className="absolute top-0 left-0 w-full h-full pointer-events-none z-0">
                        {lines.map((l, i) => (
                          <path 
                            key={'l'+i}
                            d={`M ${l.x1} ${l.y1} C ${l.x1} ${l.y1 + 24}, ${l.x2} ${l.y2 - 24}, ${l.x2} ${l.y2}`}
                            stroke={l.color}
                            strokeWidth="3"
                            fill="none"
                            opacity={l.isMerge ? "0.6" : "1"}
                            strokeDasharray={l.isMerge ? "4,4" : "none"}
                          />
                        ))}
                        {nodes.map(n => (
                          <circle key={'n'+n.sha} cx={n.x} cy={n.y} r="5" fill={n.color} stroke="#fff" strokeWidth="2" className="drop-shadow-sm" />
                        ))}
                      </svg>
                    </div>
                  )}
                  
                  <div className="space-y-3 flex-1 min-w-0 pb-12">
                    {filteredCommits.length === 0 && (
                      <div className="p-10 text-center text-slate-400 italic">No commits match your search.</div>
                    )}
                    {filteredCommits.map((c, i) => {
                      const branchNamesHere = Object.entries(state.branches).filter(([b, s]) => s === c.sha).map(([b]) => b);
                      const isHeadHere = branchNamesHere.includes(state.head);

                      return (
                        <div 
                          key={c.sha} 
                          onClick={() => handleOpenCommitDiff(c)}
                          className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex items-center justify-between gap-4 group h-[88px] relative z-10"
                        >
                          <div className="flex items-center gap-4 flex-1 min-w-0">
                            <div className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 font-bold shrink-0 text-sm group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
                              {c.author.split(' ').map(x=>x[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0 mt-0.5">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <h3 className="text-[15px] font-bold text-slate-800 truncate group-hover:text-indigo-700 transition-colors">{c.message}</h3>
                                {isHeadHere && (
                                  <span className="px-2 py-[1px] rounded bg-emerald-100 text-emerald-700 text-[10px] font-bold border border-emerald-200 w-max shrink-0">HEAD</span>
                                )}
                                {branchNamesHere.map((b) => (
                                  <span key={b} className="px-2 py-[1px] rounded bg-indigo-50 text-indigo-600 text-[10px] font-bold border border-indigo-200 w-max shrink-0">{b}</span>
                                ))}
                              </div>
                              <div className="text-[12px] text-slate-500 flex items-center gap-2">
                                <span className="font-semibold text-slate-700">{c.author}</span>
                                <span>•</span>
                                <span>{new Date(c.date).toLocaleDateString()}</span>
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 flex items-center">
                            <div className="font-mono text-[11px] font-bold text-slate-500 bg-slate-50 px-2.5 py-1 rounded border border-slate-200 group-hover:border-indigo-200 group-hover:bg-indigo-50 group-hover:text-indigo-700 transition-colors">
                              {c.short}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              )
            })()}

            {/* CHANGES TAB */}
            {activeTab === 'changes' && (
              <div className="max-w-4xl mx-auto animation-fade-in pb-10">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-xl font-bold text-slate-800">Working Tree Changes</h2>
                  <div className="space-x-2">
                    <button onClick={() => runAction('add .').then(()=>loadData())} className="text-xs font-bold bg-indigo-50 border border-indigo-200 text-indigo-700 px-3 py-1.5 rounded hover:bg-indigo-100 transition shadow-sm">Stage All</button>
                    <button onClick={handleOpenCommitDialog} className="text-xs font-bold bg-emerald-600 border border-emerald-700 text-white px-3 py-1.5 rounded hover:bg-emerald-500 transition shadow-sm">Commit</button>
                  </div>
                </div>

                {!state.status && (
                  <div className="p-8 text-center text-slate-500">Loading status...</div>
                )}
                {state.status && (state.status.toCommit.length === 0 && state.status.notStaged.length === 0 && state.status.untracked.length === 0) && (
                  <div className="p-10 text-center flex flex-col items-center justify-center text-slate-500 bg-white border border-slate-200 rounded-xl shadow-sm">
                    <div className="text-4xl mb-3">✨</div>
                    <div className="font-bold text-slate-700 mb-1">Working tree clean</div>
                    <div className="text-sm">Nothing to commit, no un-tracked files.</div>
                  </div>
                )}
                {state.status && (state.status.toCommit.length > 0 || state.status.notStaged.length > 0 || state.status.untracked.length > 0) && (
                  <div className="space-y-6">
                    {/* Staged Changes */}
                    {state.status.toCommit.length > 0 && (
                      <div className="bg-white border border-emerald-200 rounded-xl shadow-sm overflow-hidden">
                        <div className="bg-emerald-50 px-4 py-2.5 border-b border-emerald-100 flex justify-between items-center">
                          <span className="text-xs font-bold text-emerald-800 uppercase tracking-widest">Staged (To Commit)</span>
                          <span className="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded">{state.status.toCommit.length} files</span>
                        </div>
                        <div className="divide-y divide-slate-100 p-2">
                          {state.status.toCommit.map(f => (
                            <div key={f.file} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded group">
                              <div className="flex items-center gap-3">
                                {f.isConflict ? <span className="text-[10px] bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 w-max"><AlertCircle size={10}/> Conflict</span> : <span className="font-mono text-[10px] font-bold text-emerald-600 w-12 text-right break-keep">{f.type === 'new file' ? 'new' : f.type}</span>}
                                <span className="font-mono text-sm text-slate-800 font-medium">{f.file}</span>
                              </div>
                                {f.isConflict && (
                                  <button onClick={() => handleResolveConflict(f.file)} className="text-[10px] font-bold text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 px-3 py-1 rounded shadow-sm transition-all uppercase flex items-center gap-1"><AlertCircle size={12}/> Resolve</button>
                                )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Unstaged Changes */}
                    {state.status.notStaged.length > 0 && (
                      <div className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden">
                        <div className="bg-amber-50 px-4 py-2.5 border-b border-amber-100 flex justify-between items-center">
                          <span className="text-xs font-bold text-amber-800 uppercase tracking-widest">Modified (Not Staged)</span>
                          <span className="text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded">{state.status.notStaged.length} files</span>
                        </div>
                        <div className="divide-y divide-slate-100 p-2">
                          {state.status.notStaged.map(f => (
                            <div key={f.file} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded group">
                              <div className="flex items-center gap-3">
                                {f.isConflict ? <span className="text-[10px] bg-red-100 text-red-600 font-bold px-1.5 py-0.5 rounded uppercase flex items-center gap-1 w-max"><AlertCircle size={10}/> Conflict</span> : <span className="font-mono text-[10px] font-bold text-amber-600 w-12 text-right break-keep">{f.type}</span>}
                                <span className="font-mono text-sm text-slate-800 font-medium">{f.file}</span>
                              </div>
                              <div className="flex gap-2">
                                {f.isConflict ? (
                                  <button onClick={() => handleResolveConflict(f.file)} className="text-[10px] font-bold text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 px-3 py-1 rounded shadow-sm transition-all uppercase flex items-center gap-1"><AlertCircle size={12}/> Resolve</button>
                                ) : (
                                  <button onClick={() => runAction(`add ${f.file}`).then(()=>loadData())} className="text-[10px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 uppercase px-3 py-1 rounded shadow-sm opacity-0 group-hover:opacity-100 transition-all">Stage</button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Untracked Files */}
                    {state.status.untracked.length > 0 && (
                      <div className="bg-white border border-slate-300 rounded-xl shadow-sm overflow-hidden">
                        <div className="bg-slate-100 px-4 py-2.5 border-b border-slate-200 flex justify-between items-center">
                          <span className="text-xs font-bold text-slate-600 uppercase tracking-widest">Untracked files</span>
                          <span className="text-[10px] font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded">{state.status.untracked.length} files</span>
                        </div>
                        <div className="divide-y divide-slate-100 p-2">
                          {state.status.untracked.map(f => (
                            <div key={f} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded group">
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-[10px] font-bold text-slate-400 w-12 text-right break-keep">new</span>
                                <span className="font-mono text-sm text-slate-800 font-medium">{f}</span>
                              </div>
                              <button onClick={() => runAction(`add ${f}`).then(()=>loadData())} className="text-[10px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 uppercase px-3 py-1 rounded shadow-sm opacity-0 group-hover:opacity-100 transition-all">Track</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {showCommitDialog && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4">
                <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-bold text-slate-800">Create Commit</h3>
                      <p className="text-xs text-slate-500 mt-1">Stage all changes, then commit them from the desktop UI.</p>
                    </div>
                    <button onClick={() => setShowCommitDialog(false)} className="p-2 rounded-lg hover:bg-white text-slate-500 hover:text-slate-800 border border-transparent hover:border-slate-200">
                      <X size={16} />
                    </button>
                  </div>
                  <div className="p-5 space-y-4">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-2">Commit Message</label>
                      <textarea
                        value={commitMessage}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        placeholder="Describe what changed..."
                        rows={4}
                        className="w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Commit Preview</span>
                        <span className="text-[10px] font-bold text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">{latestTreeItems.files.length} files</span>
                      </div>
                      {latestTreeItems.folders.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {latestTreeItems.folders.map(folder => (
                            <span key={folder} className="text-[10px] font-mono text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-1 rounded-full">📁 {folder}</span>
                          ))}
                        </div>
                      )}
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                        {latestTreeItems.files.map(file => (
                          <div key={file.path} className="flex items-center justify-between text-xs bg-white border border-slate-200 rounded-lg px-3 py-2">
                            <span className="font-mono text-slate-700 truncate">{file.path}</span>
                            <span className="font-mono text-[10px] text-slate-400 shrink-0 ml-3">{file.sha.slice(0, 7)}</span>
                          </div>
                        ))}
                        {latestTreeItems.files.length === 0 && (
                          <div className="text-sm text-slate-500 italic text-center py-4">No tracked files found in the latest snapshot.</div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
                    <button onClick={() => setShowCommitDialog(false)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-800 rounded-lg hover:bg-white border border-transparent hover:border-slate-200 transition-colors">Cancel</button>
                    <button
                      onClick={handleCreateCommit}
                      disabled={isCommitting}
                      className="px-4 py-2 text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 rounded-lg shadow-sm transition-colors"
                    >
                      {isCommitting ? 'Committing...' : 'Stage All & Commit'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* CODE TAB */}
            {activeTab === 'code' && (
              <div className="max-w-4xl mx-auto animation-fade-in pb-10">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-xl font-bold text-slate-800">Tracked Files</h2>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Search files..."
                      value={fileSearch}
                      onChange={e => setFileSearch(e.target.value)}
                      className="text-sm px-3 py-1.5 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:border-indigo-500 w-64 text-slate-700"
                    />
                  </div>
                </div>

                {activeFile ? (
                  <div className="bg-white border border-slate-300 rounded-xl shadow-lg mb-6 overflow-hidden flex flex-col items-stretch max-h-[75vh]">
                    <div className="bg-slate-100 border-b border-slate-200 px-4 py-3 flex justify-between items-center shrink-0">
                      <div className="flex items-center gap-2">
                        <FileCode2 size={16} className={activeFile.isConflict ? "text-amber-500" : "text-slate-500"}/>
                        <span className="font-mono font-bold text-slate-800 text-sm">{activeFile.path}</span>
                        {activeFile.isConflict && <span className="ml-2 text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded uppercase flex items-center gap-1"><AlertCircle size={10}/> Resolving Merge Conflict</span>}
                        {!activeFile.isConflict && (
                          <button onClick={handleToggleBlame} className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase border transition-colors ${showBlame ? 'bg-indigo-600 text-white border-indigo-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
                            {showBlame ? 'Hide Blame' : 'Show Blame'}
                          </button>
                        )}
                      </div>
                      <button onClick={() => { setActiveFile(null); setActiveConflictBlocks(null); setShowBlame(false); setActiveBlame(null); }} className="p-1.5 bg-white border border-slate-300 rounded shadow-sm hover:bg-slate-50 text-slate-600">
                        <X size={16} />
                      </button>
                    </div>
                    
                    {activeFile.isConflict && activeConflictBlocks ? (
                      <div className="p-4 space-y-4 overflow-y-auto bg-slate-50 flex-1">
                        <div className="bg-amber-100 text-amber-900 px-4 py-3 rounded-lg border border-amber-300 font-bold flex flex-wrap items-center justify-between shadow-sm gap-4">
                          <div className="flex items-center gap-3">
                            <AlertCircle size={20} className="text-amber-600 shrink-0" />
                            <span className="text-sm">Edit the smart merge draft or choose a side for the {activeConflictBlocks.filter(b => b.type === 'conflict' && !b.draft?.trim()).length} remaining merge conflict blocks below.</span>
                          </div>
                          <button onClick={handleSaveResolution} className="bg-indigo-600 text-white font-bold px-4 py-1.5 text-xs rounded hover:bg-indigo-500 shadow-sm shrink-0 whitespace-nowrap">Save & Stage Resolved File</button>
                        </div>
                        <div className="font-mono text-[13px] border border-slate-200 rounded-lg overflow-hidden shadow-sm bg-white">
                          {activeConflictBlocks.map((b) => {
                            if (b.type === 'normal' && b.lines.length > 0) {
                              return <div key={b.id} className="p-3 text-slate-700 whitespace-pre overflow-x-auto bg-slate-50 leading-relaxed border-b border-slate-100">{b.lines.join('\n')}</div>
                            } else if (b.type === 'conflict') {
                               return (
                                <div key={b.id} className="border-y-4 my-2 relative border-amber-400 bg-slate-50">
                                  {b.resolutionChoice && (
                                    <div className="absolute top-2 right-2 z-10 bg-emerald-100 text-emerald-800 text-xs font-bold px-3 py-1 rounded shadow border border-emerald-200">{b.resolutionChoice.toUpperCase()}</div>
                                  )}
                                  <div className="bg-emerald-50 border-b border-emerald-200 p-3 relative group">
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                      <div className="text-[10px] font-bold text-emerald-700 bg-emerald-200 px-2 py-0.5 rounded w-max mb-2 uppercase tracking-widest flex items-center justify-between">Current Change (HEAD)</div>
                                      <div className="text-emerald-900 whitespace-pre overflow-x-auto">{b.currentLines.join('\n') || ' '}</div>
                                      <div className="flex flex-wrap gap-2 justify-end">
                                        <button onClick={() => handleAcceptBlock(b.id, 'current')} className="text-xs font-bold bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-700 shadow-sm">Use Current</button>
                                        <button onClick={() => handleAcceptBlock(b.id, 'both')} className="text-xs font-bold bg-slate-700 text-white px-3 py-1.5 rounded hover:bg-slate-600 shadow-sm">Use Both</button>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="bg-blue-50 p-3 relative group border-b border-blue-100">
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                      <div className="text-[10px] font-bold text-blue-700 bg-blue-200 px-2 py-0.5 rounded w-max uppercase tracking-widest">Incoming Change</div>
                                      <div className="text-blue-900 whitespace-pre overflow-x-auto">{b.incomingLines.join('\n') || ' '}</div>
                                      <div className="flex flex-wrap gap-2 justify-end">
                                        <button onClick={() => handleAcceptBlock(b.id, 'incoming')} className="text-xs font-bold bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 shadow-sm">Use Incoming</button>
                                        <button onClick={() => handleAcceptBlock(b.id, 'smart')} className="text-xs font-bold bg-violet-600 text-white px-3 py-1.5 rounded hover:bg-violet-700 shadow-sm">Smart Merge</button>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="bg-white border-t border-slate-200 p-3">
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="text-[10px] font-bold text-slate-700 bg-slate-200 px-2 py-0.5 rounded w-max uppercase tracking-widest flex items-center gap-2">
                                        Syntax-aware merge draft
                                        <span className="text-[10px] font-normal text-slate-500 normal-case">{activeFile.path.split('.').pop()?.toLowerCase() || 'text'}</span>
                                      </div>
                                      <button onClick={() => handleAcceptBlock(b.id, 'smart')} className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-1 rounded hover:bg-violet-100">Refresh smart draft</button>
                                    </div>
                                    <textarea
                                      value={b.draft || ''}
                                      onChange={(e) => handleChangeBlockDraft(b.id, e.target.value)}
                                      rows={Math.max(4, Math.min(10, Math.max((b.draft || '').split('\n').length, 4)))}
                                      className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:border-indigo-500"
                                    />
                                    <div className="mt-2 text-[11px] text-slate-500">
                                      Edit the draft directly or use the side buttons to choose a side.
                                    </div>
                                  </div>
                                </div>
                              )
                            }
                            return null;
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="p-0 overflow-y-auto bg-slate-50 flex-1">
                        {showBlame ? (
                          <div className="font-mono text-[13px] leading-relaxed select-text">
                            {blameLoading && <div className="p-6 text-center text-slate-500">Loading blame information...</div>}
                            {!blameLoading && activeBlame && activeBlame.length > 0 && activeBlame.map((entry, i) => (
                              <div key={`${entry.sha}-${i}`} className="grid grid-cols-[3.5rem_minmax(0,1fr)_11rem] border-b border-slate-100">
                                <div className="py-2 px-3 bg-slate-100 text-slate-400 text-right select-none border-r border-slate-200">{i + 1}</div>
                                <div className="py-2 px-4 whitespace-pre-wrap break-words text-slate-700 border-r border-slate-100">{entry.line || ' '}</div>
                                <div className="py-2 px-3 bg-slate-50 text-[11px] text-slate-500">
                                  <div className="font-bold text-slate-700">{entry.short}</div>
                                  <div className="truncate" title={entry.message}>{entry.author || 'Unknown'}</div>
                                </div>
                              </div>
                            ))}
                            {!blameLoading && (!activeBlame || activeBlame.length === 0) && (
                              <div className="p-6 text-center text-slate-500">No blame data available for this file.</div>
                            )}
                          </div>
                        ) : (
                          <div className="font-mono text-[13px] leading-relaxed select-text flex">
                            <div className="py-4 px-3 bg-slate-100 text-slate-400 text-right select-none border-r border-slate-200 flex flex-col items-end w-12 shrink-0">
                              {(activeFile.content || '').split('\n').map((_, i) => <span key={i}>{i+1}</span>)}
                            </div>
                            <div className="py-4 px-4 whitespace-pre overflow-x-auto text-slate-700 w-full">
                              {activeFile.content}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                  <div className="bg-slate-50 px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Latest Tree Snapshot</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Search files..."
                        value={fileSearch}
                        onChange={e => setFileSearch(e.target.value)}
                        className="text-xs px-3 py-1.5 bg-white border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:border-indigo-500 w-56 text-slate-700"
                      />
                      <span className="font-mono text-xs text-slate-400 font-bold">{state.commits[0]?.short || 'none'}</span>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {visibleTreeFiles.length === 0 ? (
                      <div className="p-10 text-center text-slate-400 italic">No tracked files in this commit</div>
                    ) : (
                      <div>
                        {latestTreeItems.folders.length > 0 && (
                          <div className="px-5 py-3 bg-slate-50 border-b border-slate-100">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Folders</div>
                            <div className="flex flex-wrap gap-2">
                              {latestTreeItems.folders.map(folder => (
                                <span key={folder} className="text-[10px] font-mono text-slate-600 bg-white border border-slate-200 px-2.5 py-1 rounded-full">📁 {folder}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {visibleTreeFiles.map(f => (
                          <div 
                            key={f.path} 
                            onClick={() => handleOpenFile(f)}
                            className="flex items-center justify-between px-5 py-3.5 hover:bg-indigo-50 cursor-pointer transition-colors group"
                          >
                            <div className="flex items-center gap-3">
                              <FileCode2 className="text-slate-400 group-hover:text-indigo-500 transition-colors" size={16} />
                              <div className="flex flex-col">
                                <span className="font-mono font-medium text-slate-700 text-sm">{f.path}</span>
                              </div>
                            </div>
                            <span className="font-mono text-xs text-slate-400">{f.sha.slice(0, 7)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}


            {/* HELP / COMMANDS TAB */}
            {activeTab === 'help' && (
              <div className="max-w-5xl mx-auto animation-fade-in pb-10">
                <div className="mb-6 border-b border-slate-200 pb-4">
                  <h2 className="text-2xl font-extrabold text-slate-800">GitBro Cheat Sheet</h2>
                  <p className="text-sm text-slate-500 mt-1">Everything you need to know to harness the power of your custom Git engine.</p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    { title: "Basics", cmds: [
                      { c: "gitbro init", d: "Initialize a new, empty repository." },
                      { c: "gitbro clone <url>", d: "Clone a remote GitBro repository." },
                      { c: "gitbro status", d: "Show the working tree status (staged/unstaged files)." },
                      { c: "gitbro completion [shell]", d: "Print shell completion for bash, zsh, or fish." }
                    ]},
                    { title: "Branching & Merging", cmds: [
                      { c: "gitbro branch [name]", d: "List all branches, or create a new branch." },
                      { c: "gitbro checkout <branch>", d: "Switch working directory to a specific branch." },
                      { c: "gitbro merge <branch>", d: "Merge the specified branch into your current branch." }
                    ]},
                    { title: "Making Changes", cmds: [
                      { c: "gitbro add <files>", d: "Stage files for the next commit." },
                      { c: "gitbro commit -m \"msg\"", d: "Record staged changes permanently as a commit." },
                      { c: "gitbro amend -m \"msg\"", d: "Alias for commit-amend; amend the last commit." },
                      { c: "gitbro diff [--cached]", d: "Show unstaged (or staged) line-by-line file differences." }
                    ]},
                    { title: "Time Travel", cmds: [
                      { c: "gitbro log", d: "View the entire commit history for this branch." },
                    ]},
                    { title: "Remote Sync", cmds: [
                      { c: "gitbro remote add <n> <url>", d: "Add a remote server connection." },
                      { c: "gitbro push", d: "Push current branch to remote server." },
                      { c: "gitbro pull", d: "Fetch and merge commits from the remote server." }
                    ]}
                  ].map((section, si) => (
                    <div key={si} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">{section.title}</h3>
                      <div className="space-y-4">
                        {section.cmds.map((cmd, ci) => (
                          <div key={ci}>
                            <div className="font-mono text-[13px] font-bold text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded inline-block border border-indigo-100 mb-1">{cmd.c}</div>
                            <div className="text-sm text-slate-600 leading-relaxed font-medium">{cmd.d}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Global Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 bg-slate-800 text-white px-5 py-3 rounded-lg shadow-2xl flex items-center gap-3 animation-fade-in z-[100] border border-slate-700">
          <div className="w-2 h-2 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
          <span className="text-sm font-bold tracking-wide">{toastMsg}</span>
        </div>
      )}
    </div>
  )
}
