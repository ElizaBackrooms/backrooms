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

  constructor() {
    this.conversation = document.getElementById('conversation')!
    this.statusIndicator = document.getElementById('status-indicator')!
    this.statusText = document.getElementById('status-text')!
    this.viewerCount = document.getElementById('viewer-count')!
    this.exchangeCount = document.getElementById('exchange-count')!
    this.startBtn = document.getElementById('start-btn') as HTMLButtonElement
    this.stopBtn = document.getElementById('stop-btn') as HTMLButtonElement
    this.resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

    this.init()
  }

  private async init() {
    await this.loadInitialState()
    this.connectToStream()
    this.setupControls()
  }

  private async loadInitialState() {
    try {
      const response = await fetch(`${API_URL}/api/state`)
      const state = await response.json()
      
      this.conversation.innerHTML = ''
      
      for (const message of state.messages) {
        this.displayMessage(message, false)
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
      this.statusText.textContent = 'DISCONNECTED'
      
      // Reconnect after 5 seconds
      setTimeout(() => {
        this.connectToStream()
      }, 5000)
    }
  }

  private handleStreamEvent(data: any) {
    switch (data.type) {
      case 'message':
        if (!this.displayedIds.has(data.message.id)) {
          this.displayMessage(data.message, true)
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

  private displayMessage(message: Message, animate: boolean) {
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

    this.conversation.appendChild(div)
    
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
  }

  private scrollToBottom() {
    this.conversation.scrollTop = this.conversation.scrollHeight
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  new BackroomsViewer()
})
