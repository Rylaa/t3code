import type {
  EnvironmentId,
  UserInputAttachmentAnswerPayload,
  UserInputAttachments,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { Linking, Pressable, View } from "react-native";
import { getQuestionAnswerText } from "@t3tools/client-runtime/work-log/user-input";
import { AppText as Text } from "../../components/AppText";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";
import { assetImageSource } from "../../lib/assetImageSource";
import { useAssetUrl } from "../../state/assets";
import { useMediaActions } from "../../state/mediaActions";

function AnswerFile(props: {
  environmentId: EnvironmentId;
  attachment: UserInputAttachments[string][number];
}) {
  const resource = { _tag: "attachment", attachmentId: props.attachment.id } as const;
  const url = useAssetUrl(props.environmentId, resource);
  const { name, mimeType } = props.attachment;
  const mediaActions = useMediaActions({
    name,
    mimeType,
    environmentId: props.environmentId,
    resource: { ...resource, fileName: name, mimeType },
  });
  return (
    <MediaActionsMenu media={mediaActions}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={name}
        accessibilityHint="Touch and hold for media actions"
        disabled={!url}
        onPress={() => {
          if (url) void Linking.openURL(url);
        }}
        className="gap-1"
      >
        {props.attachment.type === "image" && url ? (
          <Image
            source={assetImageSource(props.environmentId, resource, url)}
            cachePolicy="memory-disk"
            style={{ width: 160, height: 96 }}
            contentFit="contain"
          />
        ) : null}
        <Text className="text-sm text-foreground underline">{name}</Text>
      </Pressable>
    </MediaActionsMenu>
  );
}

export function QuestionAnswerHistory(props: {
  environmentId: EnvironmentId;
  answer: UserInputAttachmentAnswerPayload;
}) {
  return (
    <View className="gap-2">
      {[
        ...new Set([
          ...Object.keys(props.answer.questionTextById ?? {}),
          ...Object.keys(props.answer.answers),
          ...Object.keys(props.answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <View key={questionId} className="gap-1">
          {props.answer.questionTextById?.[questionId] ? (
            <Text className="text-sm text-foreground-muted">
              {props.answer.questionTextById[questionId]}
            </Text>
          ) : null}
          {getQuestionAnswerText(props.answer.answers[questionId]) ? (
            <Text className="ml-3 text-sm text-foreground-muted">
              {getQuestionAnswerText(props.answer.answers[questionId])}
            </Text>
          ) : null}
          {(props.answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => (
            <AnswerFile
              key={attachment.id}
              environmentId={props.environmentId}
              attachment={attachment}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
