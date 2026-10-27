# GitBro - Git Implementation from Scratch


## 🎯 What is GitBro?

GitBro is a complete Git implementation written entirely in JavaScript (no git dependency). It demonstrates how version control works under the hood by implementing:

- **SHA-1 hashing** for content-addressable storage
- **Tree/Blob/Commit object model** (Git's core data structure)
- **Push/Pull synchronization** over HTTP
- **Branch management** and **merge algorithms** with conflict detection
- **Web API server** for remote operations
- **Desktop UI** (Electron + React) for visualization

## ✨ Features

✅ **Complete Git Workflow**
- `init`, `add`, `commit`, `branch`, `checkout`, `merge`
- `push`, `pull`, `clone` across networks
- `log`, `diff`, `status` for visibility

✅ **Distributed Collaboration**
- Push/pull from any IP address (same WiFi, different subnets, cloud servers)
- Bare repositories for central servers
- Merge conflict detection and resolution

✅ **Network Flexibility**
- Local network (LAN)
- Different subnets/VPN
- Internet/cloud servers
- No authentication overhead (perfect for local teams)

✅ **User Interfaces**
- **CLI Tool** (Node.js) - Full command-line control
- **Web API Server** - HTTP endpoints for remote sync
- **Desktop GUI** (Electron + React) - Visual repository browser

## 🚀 Quick Start

### Installation

```bash
# Clone or download the project
cd gitbro

# Install CLI tool
cd mygit
npm install
npm link

# Verify installation
gitbro --version
```

### Use It Locally

```bash
# Create a repo
gitbro init my-project
cd my-project

# Make changes
echo "Hello" > README.md
gitbro add README.md
gitbro commit -m "Initial commit"

# View history
gitbro log
```

### Team Setup (Shared Server)

**On Server Computer:**
```bash
mkdir team-repo.git
cd team-repo.git
gitbro init
gitbro webui -p 3000
```

**On Team Member's Computer:**
```bash
gitbro init my-project
cd my-project
echo "# Project" > README.md
gitbro add README.md
gitbro commit -m "Start"

# Add server as remote
gitbro remote add origin http://192.168.1.50:3000

# Push to server
gitbro push origin main
```

**Other Team Members:**
```bash
# Clone entire project
gitbro clone http://192.168.1.50:3000 my-project
cd my-project

# Make changes
gitbro branch feature-xyz
gitbro checkout feature-xyz
# ... edit files ...
gitbro add .
gitbro commit -m "Add feature"
gitbro push origin feature-xyz
```

## 📁 Project Structure

```
gitbro/
├── mygit/                      # CLI Tool & Backend
│   ├── bin/gitbro.js           # Command-line entry point
│   ├── src/
│   │   ├── init.js             # Repository initialization
│   │   ├── add.js              # Stage files
│   │   ├── commit.js           # Create commits (SHA-1 hashing)
│   │   ├── branch.js           # Branch operations
│   │   ├── checkout.js         # Switch branches
│   │   ├── merge.js            # Merge with conflict detection
│   │   ├── push.js             # Push to remote server
│   │   ├── pull.js             # Pull from remote server
│   │   ├── clone.js            # Clone repositories
│   │   ├── log.js              # View commit history
│   │   ├── diff.js             # Show changes
│   │   ├── status.js           # Repository status
│   │   ├── webui.js            # HTTP API server
│   │   ├── remote.js           # Remote management
│   │   └── utils/
│   │       ├── objects.js      # Zlib compression, object storage
│   │       └── ignore.js       # .gitbroignore support
│   └── package.json
│
├── gitbro-desktop/             # Desktop Application
│   ├── electron/
│   │   ├── main.js             # Electron main process
│   │   └── preload.js          # Preload script
│   ├── src/
│   │   ├── App.jsx             # React UI components
│   │   ├── index.css           # Tailwind styles
│   │   └── main.jsx            # React entry point
│   ├── vite.config.js          # Vite configuration
│   ├── tailwind.config.js      # Tailwind configuration
│   └── package.json
│
├── GITBRO_SETUP_GUIDE.md       # Comprehensive setup guide
└── README.md                   # This file
```

## 🛠 Tech Stack

- **Backend:** Node.js 18+, custom HTTP server
- **Frontend:** React 18, Vite, Tailwind CSS
- **Desktop:** Electron
- **Git Core:** SHA-1 hashing, zlib compression, tree/blob/commit objects
- **CLI:** Commander.js

## 📖 Documentation

See [GITBRO_SETUP_GUIDE.md](./GITBRO_SETUP_GUIDE.md) for:
- Detailed installation steps
- Local usage guide
- Remote server setup
- Network architecture & scalability
- Team collaboration workflow
- Production deployment options
- Complete command reference
- Troubleshooting

## 🎓 Supported Commands

### Repository Management
```bash
gitbro init [directory]          # Initialize repo
gitbro clone <url> [directory]   # Clone remote repo
gitbro status                    # Show status
gitbro log                       # View history
```

### Staging & Committing
```bash
gitbro add <files...>            # Stage files
gitbro commit -m "message"       # Commit staged changes
gitbro commit-amend -m "new message"    # Amend last commit (alias: `gitbro amend -m "new message"`)
gitbro diff                      # Show unstaged changes
gitbro diff --cached             # Show staged changes
```

### Branches
```bash
gitbro branch                    # List branches
gitbro branch <name>             # Create branch
gitbro branch -d <name>          # Delete branch
gitbro checkout <branch>         # Switch branch
gitbro merge <branch>            # Merge branch
```

### Remote Operations
```bash
gitbro remote add <name> <url>   # Add remote
gitbro remote                    # List remotes
gitbro remote remove <name>      # Remove remote
gitbro push [remote] [branch]    # Push to remote
gitbro pull [remote] [branch]    # Pull from remote
```

### Other
```bash
gitbro hash-object <file> [-w]   # Hash a file
gitbro cat-file <hash>           # Show object content
gitbro rm <file>                 # Remove file
gitbro config [key] [value]      # Set config
gitbro webui [-p <port>]         # Start web server
```

## 🌐 Network Architecture

GitBro works across **any network** as long as team members can reach the server:

| Setup | Example | Use Case |
|-------|---------|----------|
| **Same WiFi** | `http://192.168.1.50:3000` | Office team |
| **Different Subnets** | Corporate network with multiple floors | VPN-connected teams |
| **Internet/Cloud** | `http://your-domain.com:3000` | Global team |
| **Hybrid** | Mix of local + remote members | Growing teams |

**Example:**
```
Developer A: Home WiFi (192.168.1.50)
Developer B: Office (10.0.0.25)
Developer C: Cloud VM (203.0.113.45)

All use: gitbro clone http://203.0.113.45:3000 project
✅ Works perfectly!
```

## 🔐 Current Capabilities & Limitations

### ✅ What Works
- Complete local Git workflow
- Push/pull across networks (HTTP)
- Branch creation, merging, conflict detection
- Multiple team members on same server
- Desktop and CLI interfaces

### ⚠️ Current Limitations (Future Enhancements)
- **No Authentication** - Any IP reaching server can push/pull (use firewalls)
- **No HTTPS** - Data sent in plain HTTP (fine for LANs)
- **No Authorization** - No per-user permission control
- **No SSH** - Only HTTP protocol

### 🚀 Recommended for
- Small teams (5-20 developers)
- Local networks or corporate VPNs
- Learning Git internals
- Portfolio/resume projects


## 🎯 Getting Started

1. **Clone or download** this repository
2. **Install CLI:**
   ```bash
   cd mygit
   npm install
   npm link
   ```
3. **Test it:**
   ```bash
   gitbro --version
   gitbro --help
   ```
4. **Start a project:**
   ```bash
   gitbro init my-project
   cd my-project
   ```
5. **For team setup:** Follow [GITBRO_SETUP_GUIDE.md](./GITBRO_SETUP_GUIDE.md)

## 📝 License

MIT - Use freely for learning and projects

## 👨‍💻 Author

Built as a hackathon project to demonstrate:
- How Git works under the hood
- Full-stack JavaScript development
- Network protocols and distributed systems
- Complete software architecture design

---

**Questions?** Check [GITBRO_SETUP_GUIDE.md](./GITBRO_SETUP_GUIDE.md) for comprehensive documentation and troubleshooting.

**Try it now:**
```bash
npm install && cd mygit && npm link && gitbro --help
```

Perfect for learning, portfolios, and team collaboration! 🚀
