## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

1. **Overview**  
   The goal is to create a multi-participant p2p quiz platform. This involves both **front-end** (handling multiple questions, storing quizzes in arrays, and displaying them) and **back-end** (signaling server logic to accommodate multiple participants’ offers, answers, and ICE candidates).

2. **Multiple Questions — Technical Details & Algorithmic Overview**  
   - **Creator Side**  
     - **Data Structure**:  
       Instead of having a single `quizQuestion` and `quizAnswer` state, maintain an array of quiz objects, e.g. `[{ question: string, answer: string }, ...]`.  
       Whenever the user enters a new question and answer, create an object, push it into this array, and send it over the data channel.  
     - **UI Flow**:  
       Provide a list (or history) in the UI (e.g., `sentQuizzes`) so the creator can track which questions they have sent. You can either show them all at once or just maintain them in state.  

   - **Participant Side**  
     - **Data Structure**:  
       Use an array `receivedQuizzes` to store multiple incoming quiz messages. Each time a new quiz arrives, parse it and push it onto this array.  
     - **UI Flow**:  
       Display each quiz to the participant. This could be a list, or a “current question” followed by “past questions,” depending on your design.  

   - **Data Channel Logic**  
     - **Message Format**:  
       Continue using an object structure like `{ type: 'quiz', payload: {...} }`. For each new quiz, send a new message.  
     - **Receiving Messages**:  
       On the participant’s side, when receiving a quiz message, parse the payload and store it in `receivedQuizzes`.  

3. **Multiple Participants — Technical Details & Algorithmic Overview**  
   - **Signaling Server Restructuring**  
     - **Current Limitation**:  
       The server code only stores a single “offer” and a single “answer.” That corresponds to the assumption of one creator and one participant.  
     - **Data Structure Changes**:  
       You need to track multiple participants inside `connections`. One strategy is to do something like:
       \[
         \text{connections.get(sessionId)} = \{
           \text{offer: RTCSessionDescriptionInit,}
           \text{creatorIce: RTCIceCandidateInit[],}
           \text{participants: \{ [participantId]: \{
             answer?: RTCSessionDescriptionInit,
             participantIce: RTCIceCandidateInit[]
           \} \}}
         \}
       \]
       With this structure, you can store multiple participants. Each participant must have a unique identifier (`participantId`).  
     - **Offer vs. Answers**:  
       - The “creator” can create one universal offer, or create a brand new PeerConnection + offer for each participant.  
       - Each participant will generate their own answer. The server stores that answer under that participant’s ID.  

   - **Creator Flow**  
     - **Multiple PeerConnections**:  
       For each new participant that appears in the server data, the creator needs to instantiate a new `RTCPeerConnection`, set remote description to the participant’s answer, and handle ICE.  
       - Alternatively, if you want to reuse a single peer connection (which is less common for multiple participants in a star topology), you’ll have to handle renegotiation. Usually, the star approach is simpler: one peer connection per participant.  
     - **Data Channels**:  
       Each `RTCPeerConnection` can have its own data channel to send quiz messages to that participant. Or, you can wait for the participant to create the data channel.  

   - **Participant Flow**  
     - **Participant Identifiers**:  
       When a participant hits the signaling endpoint, the server could generate a random participant ID, or the participant can generate one locally and send it.  
     - **Offer / Answer Retrieval**:  
       1. The participant obtains (or requests) the creator’s “offer” from the server.  
       2. The participant creates an RTCPeerConnection, sets the remote description to that offer, and creates an answer.  
       3. The answer is posted to the server with the participant’s ID so it can be associated properly.  

   - **ICE Handling**  
     - Similar to the single-participant scenario, but now each participant has their own ICE candidates. The server must store them so that the creator can retrieve each participant’s candidates. The creator also needs to send its own ICE to each participant.  

4. **Algorithmic Steps For Handling Multiple Participants**  
   1. **Creator**  
      - Creator calls a “createSession” endpoint -> gets a `sessionId`.  
      - Creator sets up local `RTCPeerConnection` with an `offer`.  
      - Server saves the universal `offer`.  
      - The creator polls the server (SSE or intervals) for newly submitted answers from participants.  
      - For each new answer, the creator spawns a new `RTCPeerConnection`, sets the remote description, adds local tracks / data channel, and completes ICE exchange.  
   2. **Participant**  
      - Participant loads the link (e.g., `?session=XYZ`).  
      - Participant fetches the universal `offer` from `sessionId=XYZ`.  
      - Participant creates local RTCPeerConnection, sets the remote description, and generates an answer.  
      - Participant sends the answer to the server along with a new random `participantId` (or the server can set this).  
      - Participant polls the server for the creator’s ICE candidates and likewise sends local ICE.  

5. **Testing & Validation**  
   - **Local Testing With Multiple Tabs**:  
     1. Open two or more participant tabs plus one creator tab.  
     2. In the creator tab, create a session and share the link with the other tabs.  
     3. Each participant joins; the creator sees multiple PeerConnections.  
     4. The creator sends multiple quiz questions; each participant receives them in real time. Each participant sends an answer, the creator sees multiple answers.  
   - **Edge Cases**:  
     - Participant joins after a question has already been sent. Decide whether the participant sees all previously sent questions or only future ones. This logic might require storing a quiz backlog in the front-end or server.  
     - Participant disconnecting: check if the creator notices this and can handle it gracefully.  
     - Many participants joining quickly – ensure signaling server data structure remains consistent.  
