// ═══════════════════════════════════════════════════════════════
// ELIZA BACKROOMS - LIVE AI CONVERSATION VIEWER
// ═══════════════════════════════════════════════════════════════

// Backend API URL (Render)
const API_URL = 'https://infinite-backrooms.onrender.com'

interface Message {
  id: string
  timestamp: number
  entity: string
  content: string
  image?: string  // Optional DALL-E generated image URL
}

interface ArchiveInfo {
  filename: string
  timestamp: number
  messageCount: number
  exchanges: number
}

class BackroomsViewer {
  private conversation: HTMLElement
  private statusIndicator: HTMLElement
  private statusText: HTMLElement
  private viewerCount: HTMLElement
  private exchangeCount: HTMLElement
  private startBtn: HTMLButtonElement
  private stopBtn: HTMLButtonElement
  private resetBtn: HTMLButtonElement
  
  private eventSource: EventSource | null = null
  private isRunning = false
  private displayedIds = new Set<string>()

  // Archives elements
  private archivesList: HTMLElement
  private archiveViewer: HTMLElement
  private archiveConversation: HTMLElement
  private archiveTitle: HTMLElement
  private backToListBtn: HTMLButtonElement

  // Chat elements
  private chatConversation: HTMLElement
  private chatInput: HTMLInputElement
  private chatSendBtn: HTMLButtonElement
  private selectedAgent: 'alpha' | 'omega' = 'alpha'
  private chatMessages: { sender: string; content: string; timestamp: number }[] = []
  private userId: string

  constructor() {
    this.conversation = document.getElementById('conversation')!
    this.statusIndicator = document.getElementById('status-indicator')!
    this.statusText = document.getElementById('status-text')!
    this.viewerCount = document.getElementById('viewer-count')!
    this.exchangeCount = document.getElementById('exchange-count')!
    this.startBtn = document.getElementById('start-btn') as HTMLButtonElement
    this.stopBtn = document.getElementById('stop-btn') as HTMLButtonElement
    this.resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

    // Archives elements
    this.archivesList = document.getElementById('archives-list')!
    this.archiveViewer = document.getElementById('archive-viewer')!
    this.archiveConversation = document.getElementById('archive-conversation')!
    this.archiveTitle = document.getElementById('archive-title')!
    this.backToListBtn = document.getElementById('back-to-list') as HTMLButtonElement

    // Chat elements
    this.chatConversation = document.getElementById('chat-conversation')!
    this.chatInput = document.getElementById('chat-input') as HTMLInputElement
    this.chatSendBtn = document.getElementById('chat-send') as HTMLButtonElement

    // Generate or retrieve user ID for chat persistence
    this.userId = localStorage.getItem('backrooms-user-id') || this.generateUserId()
    localStorage.setItem('backrooms-user-id', this.userId)

    this.init()
  }

  private generateUserId(): string {
    return 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  }

  private async init() {
    await this.loadInitialState()
    this.connectToStream()
    this.setupControls()
    this.setupTabs()
    this.setupChat()
  }

  private async loadInitialState() {
    try {
      const response = await fetch(`${API_URL}/api/state`)
      const state = await response.json()
      
      this.conversation.innerHTML = ''
      
      for (const message of state.messages) {
        this.displayMessage(message, false, this.conversation)
        this.displayedIds.add(message.id)
      }
      
      this.updateStatus(state.isRunning)
      this.exchangeCount.textContent = state.totalExchanges.toString()
      this.viewerCount.textContent = state.viewers.toString()
      
      this.scrollToBottom()
    } catch (error) {
      console.error('Failed to load initial state:', error)
      this.conversation.innerHTML = `
        <div class="loading">
          <p>> ERROR: Failed to connect to the backrooms</p>
          <p>> The void is unreachable...</p>
        </div>
      `
    }
  }

  private connectToStream() {
    this.eventSource = new EventSource(`${API_URL}/api/stream`)
    
    this.eventSource.onopen = () => {
      console.log('Connected to backrooms stream')
      this.statusIndicator.className = 'status-indicator connecting'
    }

    this.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data)
      this.handleStreamEvent(data)
    }

    this.eventSource.onerror = () => {
      console.error('Stream connection error')
      this.statusIndicator.className = 'status-indicator stopped'
      this.statusText.textContent = 'RECONNECTING...'
      
      // Reconnect after 5 seconds and reload state
      setTimeout(async () => {
        await this.loadInitialState()
        this.connectToStream()
      }, 5000)
    }
  }

  private handleStreamEvent(data: any) {
    switch (data.type) {
      case 'message':
        if (!this.displayedIds.has(data.message.id)) {
          this.displayMessage(data.message, true, this.conversation)
          this.displayedIds.add(data.message.id)
          this.exchangeCount.textContent = (parseInt(this.exchangeCount.textContent || '0') + 1).toString()
        }
        break
        
      case 'status':
        this.updateStatus(data.isRunning)
        break
        
      case 'viewers':
        this.viewerCount.textContent = data.count.toString()
        break
        
      case 'reset':
        this.conversation.innerHTML = ''
        this.displayedIds.clear()
        this.exchangeCount.textContent = '0'
        break
    }
  }

  private displayMessage(message: Message, animate: boolean, container: HTMLElement) {
    const div = document.createElement('div')
    div.className = `message ${message.entity}`
    if (!animate) div.style.animation = 'none'
    
    const time = new Date(message.timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })

    // Build image HTML if present
    const imageHtml = message.image 
      ? `<div class="message-image">
           <img src="${message.image}" alt="AI Generated Image" loading="lazy" />
           <span class="image-label">⌬ GENERATED VISUALIZATION</span>
         </div>`
      : ''

    div.innerHTML = `
      <div class="message-header">
        <span class="message-entity ${message.entity}">[${message.entity}]</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-content">${this.escapeHtml(message.content)}</div>
      ${imageHtml}
    `

    container.appendChild(div)
    
    if (animate) {
      this.scrollToBottom()
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  private updateStatus(isRunning: boolean) {
    this.isRunning = isRunning
    
    if (isRunning) {
      this.statusIndicator.className = 'status-indicator live'
      this.statusText.textContent = 'LIVE'
      this.startBtn.disabled = true
      this.stopBtn.disabled = false
    } else {
      this.statusIndicator.className = 'status-indicator stopped'
      this.statusText.textContent = 'STOPPED'
      this.startBtn.disabled = false
      this.stopBtn.disabled = true
    }
  }

  private async adminAction(endpoint: string, action: string): Promise<boolean> {
    const adminCode = prompt(`Enter admin code to ${action}:`)
    if (!adminCode) return false

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminCode })
      })
      
      if (!response.ok) {
        const data = await response.json()
        alert(data.error || 'Action failed')
        return false
      }
      return true
    } catch (error) {
      console.error(`Failed to ${action}:`, error)
      alert(`Failed to ${action}`)
      return false
    }
  }

  private setupControls() {
    this.startBtn.addEventListener('click', async () => {
      this.startBtn.disabled = true
      const success = await this.adminAction('/api/start', 'start conversation')
      if (!success) this.startBtn.disabled = false
    })

    this.stopBtn.addEventListener('click', async () => {
      this.stopBtn.disabled = true
      const success = await this.adminAction('/api/stop', 'stop conversation')
      if (!success) this.stopBtn.disabled = false
    })

    this.resetBtn.addEventListener('click', async () => {
      if (confirm('Reset the conversation? This will clear all messages.')) {
        await this.adminAction('/api/reset', 'reset conversation')
      }
    })

    // Archives back button
    this.backToListBtn.addEventListener('click', () => {
      this.archiveViewer.style.display = 'none'
      this.archivesList.style.display = 'block'
    })
  }

  private setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn')
    const tabContents = document.querySelectorAll('.tab-content')

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab')
        
        // Update active states
        tabBtns.forEach(b => b.classList.remove('active'))
        tabContents.forEach(c => c.classList.remove('active'))
        
        btn.classList.add('active')
        document.getElementById(`${tabId}-tab`)?.classList.add('active')

        // Load archives when switching to archives tab
        if (tabId === 'archives') {
          this.loadArchives()
        }
      })
    })
  }

  private async loadArchives() {
    this.archivesList.innerHTML = `
      <div class="loading">
        <p>> Fetching archives from the void...</p>
      </div>
    `

    try {
      const response = await fetch(`${API_URL}/api/archives`)
      const data = await response.json()
      
      if (data.archives.length === 0) {
        this.archivesList.innerHTML = `
          <div class="empty-archives">
            <p>> No archives found yet.</p>
            <p>> Archives are saved hourly when the conversation is active.</p>
          </div>
        `
        return
      }

      this.archivesList.innerHTML = data.archives.map((archive: ArchiveInfo) => {
        const date = new Date(archive.timestamp)
        const dateStr = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        })
        const timeStr = date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
        
        return `
          <div class="archive-item" data-filename="${archive.filename}">
            <span class="archive-date">${dateStr}</span>
            <span class="archive-time">${timeStr}</span>
            <span class="archive-arrow">→</span>
          </div>
        `
      }).join('')

      // Add click handlers
      this.archivesList.querySelectorAll('.archive-item').forEach(item => {
        item.addEventListener('click', () => {
          const filename = item.getAttribute('data-filename')
          if (filename) this.loadArchiveContent(filename)
        })
      })
    } catch (error) {
      console.error('Failed to load archives:', error)
      this.archivesList.innerHTML = `
        <div class="loading">
          <p>> ERROR: Failed to load archives</p>
          <p>> ${error}</p>
        </div>
      `
    }
  }

  private async loadArchiveContent(filename: string) {
    this.archiveConversation.innerHTML = `
      <div class="loading">
        <p>> Loading archive ${filename}...</p>
      </div>
    `
    
    this.archivesList.style.display = 'none'
    this.archiveViewer.style.display = 'block'
    this.archiveTitle.textContent = filename.replace('.json', '')

    try {
      const response = await fetch(`${API_URL}/api/archives/${filename}`)
      const data = await response.json()
      
      this.archiveConversation.innerHTML = ''
      
      for (const message of data.messages) {
        this.displayMessage(message, false, this.archiveConversation)
      }
    } catch (error) {
      console.error('Failed to load archive content:', error)
      this.archiveConversation.innerHTML = `
        <div class="loading">
          <p>> ERROR: Failed to load archive</p>
        </div>
      `
    }
  }

  private scrollToBottom() {
    this.conversation.scrollTop = this.conversation.scrollHeight
  }

  // ═══════════════════════════════════════════════════════════════
  // CHAT FUNCTIONALITY
  // ═══════════════════════════════════════════════════════════════

  private setupChat() {
    // Agent selector buttons
    const agentBtns = document.querySelectorAll('.agent-btn')
    agentBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        agentBtns.forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        this.selectedAgent = btn.getAttribute('data-agent') as 'alpha' | 'omega'
      })
    })

    // Send button
    this.chatSendBtn.addEventListener('click', () => this.sendChatMessage())

    // Enter key to send
    this.chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendChatMessage()
      }
    })
  }

  private async sendChatMessage() {
    const message = this.chatInput.value.trim()
    if (!message) return

    // Disable input while processing
    this.chatInput.disabled = true
    this.chatSendBtn.disabled = true
    this.chatInput.value = ''

    // Clear welcome message if first message
    const welcome = this.chatConversation.querySelector('.chat-welcome')
    if (welcome) {
      welcome.remove()
    }

    // Display user message
    this.displayChatMessage('user', 'YOU', message)

    // Show thinking indicator
    const thinkingDiv = document.createElement('div')
    thinkingDiv.className = 'chat-thinking'
    thinkingDiv.textContent = `${this.selectedAgent === 'alpha' ? 'CLAUDE_ALPHA' : 'CLAUDE_OMEGA'} is thinking...`
    this.chatConversation.appendChild(thinkingDiv)
    this.scrollChatToBottom()

    try {
      const response = await fetch(`${API_URL}/api/user-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          agent: this.selectedAgent,
          userId: this.userId
        })
      })

      // Remove thinking indicator
      thinkingDiv.remove()

      if (response.ok) {
        const data = await response.json()
        this.displayChatMessage(
          this.selectedAgent,
          data.agent,
          data.response
        )
      } else {
        this.displayChatMessage(
          'error',
          'SYSTEM',
          '> ERROR: Failed to reach the entity. The connection is unstable...'
        )
      }
    } catch (error) {
      thinkingDiv.remove()
      this.displayChatMessage(
        'error',
        'SYSTEM',
        '> ERROR: The backrooms are shifting. Try again.'
      )
    }

    // Re-enable input
    this.chatInput.disabled = false
    this.chatSendBtn.disabled = false
    this.chatInput.focus()
  }

  private displayChatMessage(type: string, sender: string, content: string) {
    const div = document.createElement('div')
    div.className = `chat-message ${type}`

    const time = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    })

    div.innerHTML = `
      <div class="chat-message-header">
        <span class="chat-message-sender ${type}">[${sender}]</span>
        <span class="chat-message-time">${time}</span>
      </div>
      <div class="chat-message-content">${this.escapeHtml(content)}</div>
    `

    this.chatConversation.appendChild(div)
    this.scrollChatToBottom()
  }

  private scrollChatToBottom() {
    this.chatConversation.scrollTop = this.chatConversation.scrollHeight
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  new BackroomsViewer()
})
