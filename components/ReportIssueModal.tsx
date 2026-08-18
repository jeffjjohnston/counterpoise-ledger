"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { apiPost, toMessage } from "@/lib/api-client";

interface ReportIssueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function ReportIssueModal({ isOpen, onClose, onSuccess }: ReportIssueModalProps) {
  const pathname = usePathname();
  const [description, setDescription] = useState("");
  const [type, setType] = useState("bug");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      setError("Please describe the issue.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      await apiPost("/api/issue-reports", {
        description: description.trim(),
        type,
        page: pathname,
      });

      setDescription("");
      setType("bug");
      onSuccess();
    } catch (err) {
      setError(toMessage(err, "Failed to submit report. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setError("");
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Report an Issue" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          id="report-type"
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          options={[
            { value: "bug", label: "Bug" },
            { value: "improvement", label: "Improvement" },
            { value: "other", label: "Other" },
          ]}
        />

        <Textarea
          id="report-description"
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the issue or suggestion..."
          rows={4}
          error={error || undefined}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Submitting..." : "Submit"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
