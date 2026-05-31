import { useState, useEffect } from 'react';
import { Shield, Cat } from 'lucide-react';

interface RulesModalProps {
  onAccept: () => void;
}

export function RulesModal({ onAccept }: RulesModalProps) {
  const [countdown, setCountdown] = useState(10);
  const [canAccept, setCanAccept] = useState(false);

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else {
      setCanAccept(true);
    }
  }, [countdown]);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm">
      <div className="bg-card border-2 border-primary rounded-2xl p-8 max-w-2xl w-full shadow-2xl relative">
        <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-primary rounded-full p-3">
          <Shield className="w-8 h-8 text-primary-foreground" />
        </div>

        <div className="mt-6">
          <h2 className="text-center mb-6 text-primary flex items-center justify-center gap-2">
            <Cat className="w-6 h-6" />
            Proxy Rules & Guidelines
            <Cat className="w-6 h-6" />
          </h2>

          <div className="space-y-4 mb-8 text-card-foreground">
            <div className="bg-accent/20 border border-primary/30 rounded-lg p-4">
              <h3 className="text-primary mb-2">⚠️ Critical Warning</h3>
              <p className="text-sm">
                This proxy is a private, free service. <strong>You MUST gatekeep this website</strong> unless someone is verified by our Discord server. Sharing this publicly will result in the proxy being shut down permanently.
              </p>
            </div>

            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="text-primary mb-2">📋 Rules</h3>
              <ul className="text-sm space-y-2 list-disc list-inside">
                <li>Do not abuse the API or spam requests</li>
                <li>Do not share your API keys publicly</li>
                <li>Basic request metadata is logged for abuse prevention</li>
                <li>Use responsibly and respect rate limits</li>
                <li>Only for Janitor AI chatbot purposes</li>
              </ul>
            </div>

            <div className="bg-accent/20 border border-primary/30 rounded-lg p-4">
              <h3 className="text-primary mb-2">🔒 Privacy</h3>
              <p className="text-sm">
                Your message content is never stored. Basic request metadata (model, status, timing) is logged for rate limiting and abuse prevention. Logs are only visible to admins.
              </p>
            </div>
          </div>

          <button
            onClick={onAccept}
            disabled={!canAccept}
            className={`w-full py-3 rounded-lg transition-all ${
              canAccept
                ? 'bg-primary hover:bg-primary/90 text-primary-foreground cursor-pointer'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
          >
            {canAccept ? 'I Understand' : `Please read carefully (${countdown}s)`}
          </button>

          <p className="text-center text-xs text-muted-foreground mt-4">
            🌸 By clicking "I Understand", you agree to keep this proxy private 🌸
          </p>
        </div>
      </div>
    </div>
  );
}
